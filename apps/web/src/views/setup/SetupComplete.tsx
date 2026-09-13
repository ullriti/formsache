import type { ReactElement } from 'react';

import { ProductLockup } from '../../brand/ProductLockup';

import '../../wizard/wizard.css';

export interface SetupCompleteProps {
  /** Whether an organisation really came into being in the last step. */
  readonly tenantCreated: boolean;
  /** How many steps stayed open — only as a number in the sentence. */
  readonly skipped: number;
}

/**
 * **The end of the wizard** — and the transition into the signed-in application.
 *
 * ## A reload and not a state change
 *
 * The setup is the one transition in the life of an installation at which
 * *everything* the browser knows about it is out of date: the session question,
 * the setup question, the menu, the organisation list. A `location.reload()` is
 * the most honest answer to that — it fetches every question anew instead of
 * discarding a selection of them. (The wizard deliberately did **not** write the
 * session into the query cache; see `AccessStep`.)
 *
 * ## What stands here and what does not
 *
 * No tick-box report about what has been done. What is **missing** is said by
 * the list of open items in the system administration — and that derives from
 * the actual state, not from what this flow has experienced
 * (`views/system-settings/open-items.ts`). A second report here would be the
 * version that is already wrong as soon as somebody adds a setting elsewhere.
 */
export function SetupComplete({
  tenantCreated,
  skipped,
}: SetupCompleteProps): ReactElement {
  return (
    <main className="wizard">
      <div className="wizard__card">
        <div className="wizard__stripe" />
        <div className="wizard__body">
          <p className="wizard__banner">
            <ProductLockup />
          </p>
          <h1 className="wizard__title">Eingerichtet</h1>
          <p className="wizard__intro" role="status">
            Der Zugang steht, und du bist bereits angemeldet.
            {skipped === 0
              ? ' Es ist nichts offengeblieben.'
              : ` ${String(skipped)} ${skipped === 1 ? 'Schritt wurde' : 'Schritte wurden'} übersprungen — was davon wirklich noch fehlt, steht als Liste offener Punkte in der Systemverwaltung, bis es erledigt ist.`}
          </p>

          {tenantCreated ? (
            <p className="wizard__consequence">
              <span aria-hidden="true">ⓘ </span>
              Für die neue Organisation steht ein eigener Einrichtungsschritt
              aus: Erscheinungsbild, Mailversand und Rechte werden je
              Organisation gesetzt und sind hier bewusst nicht mitentschieden
              worden. Du findest sie unter <em>Verwaltung → Organisation</em>.
            </p>
          ) : null}

          <div className="wizard__actions">
            <span className="wizard__spacer" />
            <button
              type="button"
              className="wizard__primary"
              onClick={() => {
                window.location.reload();
              }}
            >
              Zur Anwendung
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
