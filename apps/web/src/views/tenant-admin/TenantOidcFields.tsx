import type { ReactElement, ReactNode } from 'react';
import { DEFAULT_OIDC_EMAIL_CLAIM, type OidcConfig } from '@formsache/shared';

import { TextSetting, ToggleSetting } from '../settings/SettingsControls';
import type { SettingIssues } from '../settings/SettingsControls';
import type { OidcDraft } from './tenant-admin-draft';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * **Anmeldung (OIDC / SSO) as a card** — pure display over a foreign draft
 * (`use-tenant-oidc.ts`).
 *
 * Two hosts since ADR-0025: the lower half of the tab *Erscheinungsbild &
 * Login* and the seventh step of the organisation assistant. `footer` is the
 * place **in** the card at which the save bar of the tab stands; the assistant
 * leaves it empty and saves over its own button.
 */
export function TenantOidcFields({
  config,
  draft,
  setDraft,
  issues,
  footer,
}: {
  readonly config: OidcConfig;
  readonly draft: OidcDraft;
  readonly setDraft: (next: OidcDraft) => void;
  readonly issues: SettingIssues;
  readonly footer?: ReactNode;
}): ReactElement {
  const secretText =
    draft.clientSecret.kind === 'set' ? draft.clientSecret.value : '';
  const removingSecret = draft.clientSecret.kind === 'remove';

  return (
    <section
      className="settings-card tenant-admin__oidc"
      aria-labelledby="tenant-admin-oidc"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="tenant-admin-oidc">
            Anmeldung (OIDC / SSO)
          </h2>
          <p className="settings-card__hint">
            Anmeldung für Bearbeiter &amp; Administratoren, die Formulare und
            Organisationen verwalten. Teilnehmer füllen Formulare ohne Anmeldung
            aus.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <ToggleSetting
          title="SSO-Anmeldung anbieten"
          checked={draft.enabled}
          onChange={(enabled) => {
            setDraft({ ...draft, enabled });
          }}
        />

        <TextSetting
          label="Issuer / Discovery-URL"
          value={draft.issuer}
          placeholder="https://sso.example.de/realms/Organisation"
          variant="mono"
          issue={issues.issuer}
          onChange={(issuer) => {
            setDraft({ ...draft, issuer });
          }}
        />

        <div className="tenant-admin__oidc-grid">
          <TextSetting
            label="Client-ID"
            value={draft.clientId}
            variant="mono"
            issue={issues.clientId}
            onChange={(clientId) => {
              setDraft({ ...draft, clientId });
            }}
          />
          <TextSetting
            label="Scopes"
            value={draft.scopesText}
            placeholder="openid profile email"
            variant="mono"
            issue={issues.scopes}
            onChange={(scopesText) => {
              setDraft({ ...draft, scopesText });
            }}
          />
        </div>

        <div className="tenant-admin__oidc-grid">
          <TextSetting
            label="Claim mit der E-Mail-Adresse"
            value={draft.emailClaim}
            placeholder={DEFAULT_OIDC_EMAIL_CLAIM}
            variant="mono"
            issue={issues.emailClaim}
            note="Aus diesem Claim des ID-Tokens wird die Adresse gelesen. Leer lassen heißt „email“."
            onChange={(emailClaim) => {
              setDraft({ ...draft, emailClaim });
            }}
          />
          <TextSetting
            label="Claim für „Adresse geprüft“"
            value={draft.emailVerifiedClaim}
            /*
             * **No placeholder.** A grey `email_verified` in the empty field
             * would mean "that applies if you enter nothing" — and exactly
             * that is not true here: empty *is* the decision to sign in
             * without a counter-check. At the address claim next to it the
             * placeholder is right, because there empty really does mean the
             * default.
             */
            variant="mono"
            issue={issues.emailVerifiedClaim}
            /*
             * **The one field on this page that gives a guarantee up** , so the price stands at the field and is read out with
             * it — `note` is wired into `aria-describedby`, unlike a `title`,
             * which would reach the mouse and nobody else.
             */
            note={
              draft.emailVerifiedClaim.trim() === ''
                ? 'Leer: die Adresse zählt ungeprüft. Wer den Anmeldedienst dieser Organisation betreibt, kann damit eine Einladung dieser Organisation auf eine fremde Adresse ziehen.'
                : 'Nur wenn dieser Claim „true“ meldet, zählt die Adresse. Leer lassen schaltet diese Prüfung ab.'
            }
            noteTone={
              draft.emailVerifiedClaim.trim() === '' ? 'warning' : 'plain'
            }
            onChange={(emailVerifiedClaim) => {
              setDraft({ ...draft, emailVerifiedClaim });
            }}
          />
        </div>

        <TextSetting
          label="Button-Beschriftung"
          value={draft.buttonLabel}
          issue={issues.buttonLabel}
          onChange={(buttonLabel) => {
            setDraft({ ...draft, buttonLabel });
          }}
        />

        <div className="setting__field">
          <label className="setting__label" htmlFor="tenant-admin-oidc-secret">
            Client-Secret ersetzen
          </label>
          <input
            className="setting__control setting__control--mono"
            id="tenant-admin-oidc-secret"
            type="password"
            value={secretText}
            disabled={removingSecret}
            placeholder={
              config.clientSecretSet
                ? '•••••••• (unverändert)'
                : 'kein Client-Secret hinterlegt'
            }
            onChange={(event) => {
              const value = event.target.value;
              setDraft({
                ...draft,
                clientSecret:
                  value === '' ? { kind: 'keep' } : { kind: 'set', value },
              });
            }}
          />
          <p className="tenant-admin__readonly">
            {removingSecret
              ? 'Wird beim Speichern entfernt.'
              : config.clientSecretSet
                ? 'Client-Secret ist gesetzt.'
                : 'Kein Client-Secret hinterlegt.'}
          </p>
          {config.clientSecretSet ? (
            <label className="tenant-admin__checkbox">
              <input
                type="checkbox"
                checked={removingSecret}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    clientSecret: event.target.checked
                      ? { kind: 'remove' }
                      : { kind: 'keep' },
                  });
                }}
              />
              Client-Secret entfernen
            </label>
          ) : null}
        </div>

        <div className="setting__field">
          <label
            className="setting__label"
            htmlFor="tenant-admin-oidc-redirect"
          >
            Redirect-URI (im IdP eintragen)
          </label>
          <input
            className="setting__control setting__control--mono"
            id="tenant-admin-oidc-redirect"
            type="text"
            value={config.redirectUri}
            readOnly
          />
        </div>
      </div>

      {footer}
    </section>
  );
}
