import type { ReactElement } from 'react';

import {
  TENANT_AI_PATH,
  TENANT_APPEARANCE_PATH,
  TENANT_FORM_DEFAULTS_PATH,
  TENANT_LEGAL_SETTINGS_PATH,
  TENANT_MAIL_PATH,
  TENANT_MEMBERS_PATH,
} from '../router/routes';
import { navigate } from '../router/use-route';
import { MailIdentityCard } from './tenant-admin/MailIdentityCard';
import { TenantAiTab } from './tenant-admin/TenantAiTab';
import { TenantAppearanceTab } from './tenant-admin/TenantAppearanceTab';
import { TenantLegalTab } from './tenant-admin/TenantLegalTab';
import { TenantMembersTab } from './tenant-admin/TenantMembersTab';
import { TenantFormDefaultsView } from './TenantFormDefaultsView';

import './settings-view.css';
import './tenant-admin/tenant-admin-view.css';

/**
 * The five sibling addresses, in the order the tabs show them.
 *
 * The first three are handoff; *Mailversand* arrived after them and is appended rather than inserted, so an existing
 * link or E2E case that counts "the third tab" is unaffected. *KI* came as
 * the fifth (ADR-0025) and was appended for the same reason.
 */
export type TenantAdminTab =
  'appearance' | 'form-defaults' | 'members' | 'mail' | 'ai' | 'legal';

export interface TenantAdminViewProps {
  /** Id of the active Organisation, or `undefined` while none is scoped. */
  readonly tenantId?: string | undefined;
  /** Name of the active Organisation, or `undefined` while none is scoped. */
  readonly tenantName?: string | undefined;
  /**
   * Short name of the active organisation — it sits in the public addresses
   * of its legal texts (`/o/<kurzname>/…`) and is therefore threaded all the way
   * down into the tab *Rechtstexte*, instead of being read from the session
   * a second time there.
   */
  readonly tenantShortName?: string | undefined;
  /**
   * The signed-in person's own id — the *Nutzerrechte* tab's „Sie"-badge and
   * its rule against changing or removing one's own membership from this
   * screen (handoff; the server enforces the sharper „letzter Admin"
   * version of the same rule).
   */
  readonly currentUserId: string;
  /**
   * The signed-in person's own address — where the *Mailversand* tab's
   * Testmail goes. Threaded down the same way as
   * `currentUserId` rather than read via a second `useSession()` call inside
   * `MailIdentityCard`.
   */
  readonly currentUserEmail: string;
  /** Which of the five siblings the current address is. */
  readonly tab: TenantAdminTab;
}

const TAB_LABELS: Record<TenantAdminTab, string> = {
  appearance: 'Erscheinungsbild & Login',
  'form-defaults': 'Formular-Standards',
  members: 'Nutzerrechte',
  mail: 'Mailversand',
  ai: 'KI',
  legal: 'Rechtstexte',
};

const TAB_PATHS: Record<TenantAdminTab, string> = {
  appearance: TENANT_APPEARANCE_PATH,
  'form-defaults': TENANT_FORM_DEFAULTS_PATH,
  members: TENANT_MEMBERS_PATH,
  mail: TENANT_MAIL_PATH,
  ai: TENANT_AI_PATH,
  legal: TENANT_LEGAL_SETTINGS_PATH,
};

const TAB_ORDER: readonly TenantAdminTab[] = [
  'appearance',
  'form-defaults',
  'members',
  'mail',
  'ai',
  // Appended like the two before it (ADR-0028).
  'legal',
];

/**
 * Tenant administration (handoff) — four sibling addresses, one segmented
 * control switching between them.
 *
 * **Only the frame is new here.** The `form-defaults` tab is
 * `TenantFormDefaultsView`, embedded exactly as it stood before this package
 *  — its own test suite already pins "promises none of the
 * tenant-administration tabs" for the case where that view renders on its own, which is
 * deliberately still true: the tab bar lives here, one level up, not inside a
 * view three other tests already cover.
 *
 * **`mail` is the fourth, added after the handoff's own three** (ADR-0013): the organisation's own sending identity belongs
 * next to its branding and OIDC — same guard shape (`canManageSettings` on
 * the route), same reason to be a sibling address rather than a mode.
 *
 * **Why a `tab` prop and not a `useRoute()` call in here.** The four routes
 * are parsed once, in the shell, and every other view in this application
 * takes its routing facts as props rather than re-deriving them — a second
 * reading of `window.location` here would be a second router.
 *
 * **No „Live ansehen" and no „Löschen".** Both exist in the prototype because
 * its tenant editor can open *any* Organisation; every route behind this view resolves
 * the session's own active Organisation and no other („es
 * gibt keinen Weg, eine andere Organisation zu adressieren"), so there is no second
 * Organisation to preview and no organisation this view could ever offer to delete.
 */
export function TenantAdminView({
  tenantId,
  tenantName,
  tenantShortName,
  currentUserId,
  currentUserEmail,
  tab,
}: TenantAdminViewProps): ReactElement {
  const hasTenant =
    tenantId !== undefined &&
    tenantName !== undefined &&
    tenantShortName !== undefined;

  if (!hasTenant) {
    return (
      <div className="settings">
        <p className="settings__state" role="status">
          Bitte zuerst eine Organisation auswählen.
        </p>
      </div>
    );
  }

  return (
    <div className="tenant-admin">
      <div className="tenant-admin__head">
        <div className="settings__title-block">
          <h1 className="settings__title">Organisations-Verwaltung</h1>
          <p className="settings__subtitle">{tenantName}</p>
        </div>
      </div>

      {/*
        A navigation, not a tab widget — and it says so now.

        The four entries carry `role="tab"` no more: an ARIA tab promises a
        composite widget (arrow keys move between the tabs, `aria-controls`
        names the panel each one owns, one stop in the tab order for the whole
        set), and none of that was here. Claiming the role without the behaviour
        is the same defect class as a disabled control that looks like a
        function — it tells assistive technology something the page does not do.

        What these are is four sibling **addresses** (`TAB_PATHS`), each one a
        full page load away, so the honest markup is a navigation with
        `aria-current="page"` on the one being shown. Buttons rather than links
        because `navigate()` is this application's one router entry point; the
        keyboard reaches every one of them in order, which is what a group of
        links does too.
      */}
      <nav
        className="segmented tenant-admin__tabs"
        aria-label="Organisations-Verwaltung"
      >
        {TAB_ORDER.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-current={entry === tab ? 'page' : undefined}
            className={
              entry === tab
                ? 'segmented__option segmented__option--on'
                : 'segmented__option'
            }
            onClick={() => {
              navigate(TAB_PATHS[entry]);
            }}
          >
            {TAB_LABELS[entry]}
          </button>
        ))}
      </nav>

      {tab === 'appearance' ? (
        <TenantAppearanceTab tenantId={tenantId} />
      ) : tab === 'form-defaults' ? (
        <TenantFormDefaultsView tenantId={tenantId} tenantName={tenantName} />
      ) : tab === 'members' ? (
        <TenantMembersTab tenantId={tenantId} currentUserId={currentUserId} />
      ) : tab === 'mail' ? (
        <MailIdentityCard
          tenantId={tenantId}
          currentUserEmail={currentUserEmail}
        />
      ) : tab === 'legal' ? (
        <TenantLegalTab
          tenantId={tenantId}
          tenantName={tenantName}
          tenantShortName={tenantShortName}
        />
      ) : (
        <TenantAiTab tenantId={tenantId} />
      )}
    </div>
  );
}
