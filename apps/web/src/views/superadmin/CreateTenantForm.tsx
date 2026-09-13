import type { ReactElement, SyntheticEvent } from 'react';
import { useId, useState } from 'react';
import type { TenantCreate, TenantOverviewRow } from '@formsache/shared';
import type { UseMutationResult } from '@tanstack/react-query';

import { ApiError } from '../../api/http';

/*
 * The stylesheet comes along, as with `TestMailCard` and for the same reason:
 * since the setup wizard (ADR-0022, continuation
 * 2026-08-18) this form stands in **two** places — in the tab *Organisationen* and as step 7
 * of the wizard. Relying on the caller's import would mean that
 * it comes out unstyled in one of the two; that it goes well in the built
 * bundle (Vite puts all stylesheets into one file) does not make the coupling
 * more correct, only invisible.
 */
import '../superadmin-view.css';

/** What the form keeps while nothing has been sent yet. */
interface Draft {
  readonly shortName: string;
  readonly name: string;
  /** „Mich selbst als ersten Administrator eintragen" — see {@link CreateTenantForm}. */
  readonly adminIsSelf: boolean;
  readonly adminEmail: string;
  readonly adminName: string;
}

const EMPTY_DRAFT: Draft = {
  shortName: '',
  name: '',
  adminIsSelf: false,
  adminEmail: '',
  adminName: '',
};

export interface CreateTenantFormProps {
  readonly create: UseMutationResult<TenantOverviewRow, Error, TenantCreate>;
  /** Called once the organisation is created — closes the panel. */
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}

/**
 * „+ Neue Organisation" (handoff).
 *
 * **What the form does not offer, and why**: no branding, no OIDC, no form
 * standards — `tenantCreateSchema` has no field for any of the three, and a
 * control here would promise a write the server refuses. Branding and OIDC
 * wait for the *Erscheinungsbild*-tab of the tenant administration; the form
 * standards stay unset on purpose, so the new Organisation goes on following
 * the application's default — the note below says so, because a value that
 * looks identical on day one and stops inheriting is exactly the kind of
 * silent change this project has already paid for once.
 *
 * ## „Mich selbst als ersten Administrator eintragen" (review finding 7)
 *
 * The switch without which the most obvious case did not work: creating an
 * organisation and working in it oneself. Typing one's own, long
 * existing address into the fields did not help — the name applied to
 * an account that already exists, and was discarded.
 *
 * If it is on, **the fields disappear** instead of standing there locked: there is
 * nothing to enter, and an empty required field that one cannot fill
 * is a question without an answer. What is then sent is `admin: null` — *who*
 * is meant is decided by the server from the session, never by this body
 * (`tenantCreateSchema`), and **no** invitation goes out: this account
 * exists and knows its password (ADR-0024).
 */
export function CreateTenantForm({
  create,
  onCreated,
  onCancel,
}: CreateTenantFormProps): ReactElement {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const formId = useId();

  const fieldIssues =
    create.error instanceof ApiError ? (create.error.fieldIssues ?? {}) : {};
  const conflictMessage =
    create.isError && create.error instanceof ApiError
      ? create.error.detail
      : undefined;

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    create.mutate(
      {
        shortName: draft.shortName.trim(),
        name: draft.name.trim(),
        // `null` means "the signed-in superadmin account". No account field,
        // not a hidden one either: the server reads the id from the session.
        // No password any more (ADR-0024): the first administrator gets
        // an invitation and sets it themselves.
        admin: draft.adminIsSelf
          ? null
          : {
              email: draft.adminEmail.trim(),
              name: draft.adminName.trim(),
            },
      },
      { onSuccess: onCreated },
    );
  };

  return (
    <form
      className="superadmin__create"
      onSubmit={onSubmit}
      aria-labelledby={`${formId}-title`}
    >
      <div className="superadmin__create-head">
        <h2 id={`${formId}-title`} className="superadmin__create-title">
          Neue Organisation
        </h2>
        <button
          type="button"
          className="superadmin__create-close"
          onClick={onCancel}
          aria-label="Formular „Neue Organisation“ schließen"
        >
          ×
        </button>
      </div>

      <div className="superadmin__create-grid">
        <label className="superadmin__field">
          <span>Kurzname</span>
          <input
            value={draft.shortName}
            onChange={(event) => {
              setDraft({ ...draft, shortName: event.target.value });
            }}
            required
          />
          {fieldIssues.shortName === undefined ? null : (
            <span className="superadmin__field-error" role="alert">
              {fieldIssues.shortName}
            </span>
          )}
        </label>

        <label className="superadmin__field">
          <span>Name</span>
          <input
            value={draft.name}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
            required
          />
          {fieldIssues.name === undefined ? null : (
            <span className="superadmin__field-error" role="alert">
              {fieldIssues.name}
            </span>
          )}
        </label>

        <label className="superadmin__check">
          <input
            type="checkbox"
            checked={draft.adminIsSelf}
            onChange={(event) => {
              setDraft({ ...draft, adminIsSelf: event.target.checked });
            }}
          />
          <span>Mich selbst als ersten Administrator eintragen</span>
        </label>

        {draft.adminIsSelf ? (
          <p className="superadmin__create-note">
            Dieses Konto wird Mitglied der neuen Organisation und ihrer Gruppe
            „admin". Es entsteht kein zweites Konto, und an diesem hier ändert
            sich nichts.
          </p>
        ) : null}

        {draft.adminIsSelf ? null : (
          <>
            <label className="superadmin__field">
              <span>E-Mail des ersten Admins</span>
              <input
                type="email"
                value={draft.adminEmail}
                onChange={(event) => {
                  setDraft({ ...draft, adminEmail: event.target.value });
                }}
                required
              />
              {fieldIssues['admin.email'] === undefined ? null : (
                <span className="superadmin__field-error" role="alert">
                  {fieldIssues['admin.email']}
                </span>
              )}
            </label>

            <label className="superadmin__field">
              <span>Name des ersten Admins</span>
              <input
                value={draft.adminName}
                onChange={(event) => {
                  setDraft({ ...draft, adminName: event.target.value });
                }}
                required
              />
              {fieldIssues['admin.name'] === undefined ? null : (
                <span className="superadmin__field-error" role="alert">
                  {fieldIssues['admin.name']}
                </span>
              )}
            </label>

            <p className="superadmin__create-note">
              Diese Person bekommt eine Einladung per Mail und setzt ihr
              Passwort selbst. Ohne Mailserver der Instanz und ohne
              Basis-Adresse lässt sich keine verschicken — dann sagt das
              Formular es, und es entsteht nichts.
            </p>
          </>
        )}
      </div>

      <p className="superadmin__create-note">
        Mit dem Tenant entstehen die drei Standardgruppen und ein erster
        Administrator, sonst wäre die Organisation unbenutzbar. Die
        Formular-Standards bleiben dabei bewusst leer: Die Organisation folgt
        weiter der Vorgabe der Anwendung, statt sie am ersten Tag unbemerkt zu
        übernehmen.
      </p>

      {conflictMessage === undefined ? null : (
        <p className="superadmin__create-error" role="alert">
          {conflictMessage}
        </p>
      )}

      <div className="superadmin__create-actions">
        <button
          type="button"
          className="superadmin__create-cancel"
          onClick={onCancel}
          disabled={create.isPending}
        >
          Abbrechen
        </button>
        <button
          type="submit"
          className="superadmin__create-submit"
          disabled={create.isPending}
        >
          {create.isPending ? 'Wird angelegt…' : 'Organisation anlegen'}
        </button>
      </div>
    </form>
  );
}
