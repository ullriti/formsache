import type { ReactElement } from 'react';

import {
  SYSTEM_AI_PATH,
  SYSTEM_MAIL_PATH,
  SYSTEM_LEGAL_SETTINGS_PATH,
  SYSTEM_MONITORING_PATH,
  SYSTEM_PATH,
  SYSTEM_SUPERADMINS_PATH,
  SYSTEM_TEMPLATES_PATH,
} from '../router/routes';
import { navigate } from '../router/use-route';
import { OpsView } from './OpsView';
import { SuperadminView } from './SuperadminView';
import { SystemAiSettingsTab } from './system-settings/SystemAiSettingsTab';
import { SystemMailSettingsTab } from './system-settings/SystemMailSettingsTab';
import { SystemLegalTab } from './system-settings/SystemLegalTab';
import { SystemNotificationTemplatesTab } from './system-settings/SystemNotificationTemplatesTab';
import { SystemOpenItems } from './system-settings/SystemOpenItems';
import { SystemSuperadminsTab } from './system-settings/SystemSuperadminsTab';

import './settings-view.css';
import './system-admin-view.css';

/**
 * The tabs of the system administration (finding 16; *Vorlagen* since ADR-0022,
 * continuation 2026-08-18).
 *
 * They were three separate areas with three entries in the head navigation —
 * `superadmin` (Organisationen), `ops` (Betrieb) and `system-settings` with two
 * tabs of their own. Why they belong together and why each of them nonetheless
 * keeps its own address stands at the route (`router/routes.ts`).
 */
export type SystemAdminTab =
  | 'tenants'
  | 'monitoring'
  | 'mail'
  | 'templates'
  | 'ai'
  | 'legal'
  | 'superadmins';

/**
 * **„Überwachung" and not „Betrieb"** (finding 16, decision of the user).
 *
 * The old name promised an action: „Betrieb" sounds like something one
 * *does*. On the page there stands not a single button — it counts queue,
 * storage, AI consumption and background runs against the same thresholds from
 * which the alarm helps itself. What it is, is watching.
 */
const TAB_LABELS: Record<SystemAdminTab, string> = {
  tenants: 'Organisationen',
  monitoring: 'Überwachung',
  mail: 'Mailserver',
  templates: 'Vorlagen',
  ai: 'KI',
  legal: 'Rechtstexte',
  /**
   * **„Superadmins" and not „Personen"** (ADR-0029). The tab names the
   * property, not the genus: „Personen" would stand next to *Organisationen*
   * and would read like their members — and that is exactly what it is not.
   */
  superadmins: 'Superadmins',
};

const TAB_PATHS: Record<SystemAdminTab, string> = {
  tenants: SYSTEM_PATH,
  monitoring: SYSTEM_MONITORING_PATH,
  mail: SYSTEM_MAIL_PATH,
  templates: SYSTEM_TEMPLATES_PATH,
  ai: SYSTEM_AI_PATH,
  legal: SYSTEM_LEGAL_SETTINGS_PATH,
  superadmins: SYSTEM_SUPERADMINS_PATH,
};

const TAB_ORDER: readonly SystemAdminTab[] = [
  'tenants',
  'monitoring',
  'mail',
  'templates',
  'ai',
  // Appended and not inserted — the same consideration that *Mailversand* and
  // *KI* have already received: a link or an E2E case that counts "the fifth
  // tab" stays intact.
  'legal',
  // Likewise appended (ADR-0029). ⚠️ Two lists in `e2e/` count along: `TABS`
  // in `system-settings.spec.ts` (the count catches exactly the tab that
  // no loop knows) and `a11y/views.ts`, which is held against the route kinds
  // of the router. Whoever appends an eighth one here enters it there
  // afterwards — otherwise the count is red or the axe run quietly too short.
  'superadmins',
];

export interface SystemAdminViewProps {
  /** Which of the siblings the current address is — default: the first. */
  readonly tab?: SystemAdminTab;
  /**
   * The scope of the session, straight from `GET /auth/me` — only the tab
   * *Organisationen* reads it, and it reads it in order to mark its own row,
   * not in order to derive rights from it.
   */
  readonly activeTenantId: string | null;
  /**
   * One's own id, straight from `GET /auth/me` — only the tab
   * *Superadmins* reads it, for the marker „Du" and the wording of the
   * confirmation question. Passed through instead of fetched via a second
   * `useSession()` in the tab, as `TenantAdminView` keeps it one level deeper.
   */
  readonly currentUserId: string;
}

/**
 * **System administration** — sibling addresses under one tab bar, the
 * shape that `TenantAdminView` gives the organisation one level above.
 *
 * **Only the frame stands here.** Title, the red marker „Alle Organisationen"
 * (the reach of these pages) and which tab is open — no more.
 * Every tab is a component of its own with its own hooks, its own loading and
 * its own error state.
 *
 * **Reachable via the address also for somebody who is not allowed.** The
 * navigation entry does not appear without the superadmin property, but that
 * is politeness; the boundary is the guard behind every single route, and
 * what a 403 on the screen means each tab says itself
 * (`CONTRIBUTING.md`).
 */
export function SystemAdminView({
  tab = 'tenants',
  activeTenantId,
  currentUserId,
}: SystemAdminViewProps): ReactElement {
  return (
    <div className="system-admin">
      <div className="settings__head">
        <div className="settings__title-block">
          <h1 className="settings__title">Systemverwaltung</h1>
        </div>
        {/*
          The red marker of the handoff: what stands on these pages applies to
          the whole installation and not to the organisation in which somebody
          is working at the moment.
        */}
        <span className="settings__scope">Alle Organisationen</span>
      </div>

      {/*
        **What the setup left open** (ADR-0022, continuation
        2026-08-18). Above the tabs and not in one of them: the missing
        mail server is no finding of the mail tab, but one of the
        installation. If nothing is open, nothing stands here either.
      */}
      <SystemOpenItems />

      {/*
        A navigation, not a tab widget — the same shape and the same
        reasoning that `TenantAdminView` gives its own siblings: these
        are addresses of their own (`TAB_PATHS`), not areas of one
        composite control, so `aria-current="page"` is the
        honest markup and not `role="tab"`.
      */}
      <nav className="segmented segmented--tabs" aria-label="Systemverwaltung">
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

      {tab === 'tenants' ? (
        <SuperadminView activeTenantId={activeTenantId} />
      ) : tab === 'monitoring' ? (
        <OpsView />
      ) : tab === 'superadmins' ? (
        /*
          In the **narrow** column like the form tabs: pulling a person row
          across the width of an organisation table does not make it
          more readable, only longer.
        */
        <div className="system-admin__forms">
          <SystemSuperadminsTab currentUserId={currentUserId} />
        </div>
      ) : (
        /*
          The three form tabs in a **narrower** column than the
          tables next to them (`--layout-settings-max`, as wide as the
          form settings). Pulling an input row across the full width of
          a tenant table does not make it more operable, only longer.
        */
        <div className="system-admin__forms">
          {tab === 'mail' ? (
            <SystemMailSettingsTab />
          ) : tab === 'templates' ? (
            <SystemNotificationTemplatesTab />
          ) : tab === 'legal' ? (
            <SystemLegalTab />
          ) : (
            <SystemAiSettingsTab />
          )}
        </div>
      )}
    </div>
  );
}
