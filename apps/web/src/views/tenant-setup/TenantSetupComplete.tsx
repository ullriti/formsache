import type { ReactElement } from 'react';

import { DASHBOARD_PATH } from '../../router/routes';
import { navigate } from '../../router/use-route';

import '../../wizard/wizard.css';

export interface TenantSetupCompleteProps {
  readonly tenantName: string;
  /** How many steps were left open — only as a number in the sentence. */
  readonly skipped: number;
}

/**
 * **The end of the organization wizard** — and the way to the dashboard.
 *
 * ## No reload, unlike at the end of the initial setup
 *
 * There the session changes, and *everything* the browser knows is stale. Not
 * here: it is the same session, the same organization, the same application —
 * what has changed are documents whose cache entries the save operations
 * themselves have already replaced. A `location.reload()` would be a
 * sledgehammer for a navigation here.
 *
 * ## What is stated here and what is not
 *
 * No checkmark report. What is **missing** is stated by the list of open items
 * on this organization's dashboard — derived from the actual state and not from
 * what this flow experienced (`open-items.ts`). A second report here would be
 * the version that is already wrong as soon as somebody adds a setting
 * elsewhere.
 */
export function TenantSetupComplete({
  tenantName,
  skipped,
}: TenantSetupCompleteProps): ReactElement {
  return (
    <div className="wizard">
      <div className="wizard__card">
        <div className="wizard__stripe" />
        <div className="wizard__body">
          <p className="wizard__banner">{tenantName}</p>
          <h1 className="wizard__title">Eingerichtet</h1>
          <p className="wizard__intro" role="status">
            {skipped === 0
              ? 'Du bist einmal durch alle Einstellungen dieser Organisation gegangen.'
              : `${String(skipped)} ${skipped === 1 ? 'Schritt wurde' : 'Schritte wurden'} übersprungen — was davon wirklich fehlt, steht auf dem Dashboard dieser Organisation, bis es erledigt ist.`}
          </p>

          <p className="wizard__consequence">
            <span aria-hidden="true">ⓘ </span>
            Jede dieser Einstellungen bleibt änderbar: sie stehen unter{' '}
            <em>Verwaltung → Organisation</em>, jede auf ihrem eigenen Reiter.
            Dieser Assistent hat nichts entschieden, was dort nicht auch steht.
          </p>

          <div className="wizard__actions">
            <span className="wizard__spacer" />
            <button
              type="button"
              className="wizard__primary"
              onClick={() => {
                navigate(DASHBOARD_PATH);
              }}
            >
              Zum Dashboard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
