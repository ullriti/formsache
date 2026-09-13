import { TRASH_RETENTION_DAYS } from '@formsache/shared';
import type { ReactElement } from 'react';
import { useState } from 'react';
import type { TenantSummary } from '@formsache/shared';

export interface TenantDeleteConfirmProps {
  readonly tenant: TenantSummary;
  readonly isPending: boolean;
  readonly error: string | undefined;
  readonly onConfirm: (confirmName: string) => void;
  readonly onCancel: () => void;
}

/**
 * The confirmation for „Löschen" on the superadmin overview's own table
 *  — **not** `ConfirmPrompt`, and deliberately.
 *
 * Konzept no. 59's confirmation is „den Namen abtippen", which needs a text field
 * `ConfirmPrompt` has none of; every other destructive control added so far
 * (`TrashView.tsx`'s „Endgültig löschen"/„Papierkorb leeren",
 * `DashboardView.tsx`'s „× Löschen") is a click-to-confirm, and giving those
 * the same typed hurdle would blur the one distinction Konzept no. 65 spends a
 * whole decision on: this is the sole *irreversible-feeling* act among them
 * that is actually reversible for 30 days too, but it is also the one that
 * takes a **whole organisation** — every person, every form, every answer — out of
 * service in a single request, which is why the Konzept asks for the harder
 * confirmation here and nowhere else.
 *
 * **The question names the loss** — `ConfirmPromptProps.question` writes that
 * rule down for the click-to-confirm siblings, and this is the one place where
 * it matters most. „Alle Formulare, Antworten und Mitgliedschaften bleiben
 * dabei erhalten" was true of the 30-day window and silent about both ends of
 * it: the organisation is unsichtbar und unbenutzbar **sofort** , so every
 * member is locked out at the moment of the click, and after the 30 days the
 * purge is physical — including the accounts of the people this leaves in no
 * Organisation at all. The most destructive confirmation in this
 * application was the one that mentioned no destruction.
 *
 * **The typed value is sent as-is and compared on the server**
 * (`tenantDeleteSchema`, `AdminService.remove`). Nothing here pre-checks it
 * against `tenant.name` — a client-side match would be a second, weaker
 * authority over the same question, and the point of asking for the name at
 * all is that the person read it off the row in front of them, not that this
 * component agrees with itself (`CONTRIBUTING.md`). The confirm button only
 * disables on an empty field, which is a nudge to fill it in, not a promise
 * that a non-empty value is the right one.
 */
export function TenantDeleteConfirm({
  tenant,
  isPending,
  error,
  onConfirm,
  onCancel,
}: TenantDeleteConfirmProps): ReactElement {
  const [typedName, setTypedName] = useState('');

  return (
    <div className="superadmin__delete-confirm" role="alert">
      <p className="superadmin__delete-text">
        „{tenant.name}“ wird sofort unsichtbar und unbenutzbar — jedes Mitglied
        ist ab diesem Moment ausgesperrt, auch die öffentlichen Formulare der
        Organisation. Bis zum Ablauf von {String(TRASH_RETENTION_DAYS)} Tagen
        holt „Gelöschte Organisationen" alles zurück; danach werden Formulare,
        Antworten und Mitgliedschaften endgültig gelöscht — und mit ihnen die
        Konten der Personen, die dadurch in keiner Organisation mehr sind. Zum
        Bestätigen den Namen der Organisation eintippen:
      </p>
      <label className="superadmin__delete-field">
        <span className="superadmin__delete-label">
          Name der Organisation zur Bestätigung
        </span>
        <input
          value={typedName}
          placeholder={tenant.name}
          onChange={(event) => {
            setTypedName(event.target.value);
          }}
        />
      </label>
      {/*
        No `role="alert"` here — the container already carries one
        (`ConfirmPrompt`'s own convention: the confirmation question is
        announced as it is). A second, nested alert role would only make
        `getByRole('alert')` ambiguous for no benefit: this text is already
        inside the region a screen reader just announced.
      */}
      {error === undefined ? null : (
        <p className="superadmin__delete-error">{error}</p>
      )}
      <div className="superadmin__delete-actions">
        <button
          type="button"
          className="superadmin__delete-yes"
          disabled={isPending || typedName.trim() === ''}
          onClick={() => {
            onConfirm(typedName);
          }}
        >
          {isPending ? 'Wird gelöscht…' : 'Organisation löschen'}
        </button>
        <button
          type="button"
          className="superadmin__delete-no"
          onClick={onCancel}
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}
