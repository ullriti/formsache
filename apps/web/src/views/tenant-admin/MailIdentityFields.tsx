import type { ReactElement } from 'react';

import { TextSetting, ToggleSetting } from '../settings/SettingsControls';
import type { SettingIssues } from '../settings/SettingsControls';
import type { MailIdentityDraft } from './mail-identity-draft';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * **The mail server of an organisation as a card** — pure display over a
 * foreign draft (ADR-0013, ADR-0023).
 *
 * Two hosts since ADR-0025: the *Mailversand* tab (`MailIdentityCard`) and the
 * second step of the organisation assistant. The state belongs to
 * `use-tenant-smtp.ts`; what stands here are fields and the sentences that
 * explain them.
 *
 * ## The block stays indivisible, and that sits in the shape of the data
 *
 * There is no draft state that expresses „own server, sender address open" or
 * „foreign transport with an address of one's own" — the second is the
 * SPF/DKIM forgery from ADR-0013 no. 2 and the reason the block cannot be
 * written field by field. The switch switches the whole document; the fields
 * below it travel as one document or not at all (`mailIdentityWriteOf`).
 */
export interface MailIdentityFieldsProps {
  readonly draft: MailIdentityDraft;
  readonly setDraft: (next: MailIdentityDraft) => void;
  readonly issues: SettingIssues;
  /** Whether the stored row is unreadable — the repair case. */
  readonly unreadable: boolean;
  /** Whether an SMTP password is stored. */
  readonly hadPassword: boolean;
  /** The refusal at the field „Benutzername", or `undefined`. */
  readonly usernameIssue: string | undefined;
}

export function MailIdentityFields({
  draft,
  setDraft,
  issues,
  unreadable,
  hadPassword,
  usernameIssue,
}: MailIdentityFieldsProps): ReactElement {
  const passwordText =
    draft.password.kind === 'set' ? draft.password.value : '';

  return (
    <>
      {unreadable ? (
        <p className="settings__alert" role="alert">
          Die gespeicherte Mail-Konfiguration dieser Organisation konnte nicht
          gelesen werden. Solange nichts Neues gespeichert wird, gehen keine
          E-Mails dieser Organisation hinaus. Trag unten einen Mailserver ein
          und speichere, um das zu beheben.
        </p>
      ) : null}

      {/*
        **The clear notice ADR-0023 demands.** Without a mail server of its own
        this organisation no longer inherits anything — its post stays where it
        is. That is not an error and must not be silent all the same: whoever
        opens the card and sees the switch off has to know without asking what
        that means for the forms of this organisation. `role="status"` and not
        `role="alert"` — it is information about a permissible state, not a
        malfunction.
      */}
      {!draft.enabled ? (
        <p className="settings__alert" role="status">
          Ohne eigenen Mailserver verschickt diese Organisation nichts:
          Bestätigungen und Benachrichtigungen aus ihren Formularen bleiben in
          der Warteschlange. Verloren geht dabei nichts — sobald hier ein
          Mailserver steht, werden sie zugestellt.
        </p>
      ) : null}

      <ToggleSetting
        title="Mailserver eingerichtet"
        /*
          **Die Ausnahme gehört dazu** (Befund des Reviews zu Review-Runde 5).
          Sie stand bis dahin in der Konsequenz-Zeile des Einrichtungsschritts,
          und als die auf einen Satz gekürzt wurde, stand sie in **keiner**
          Ansicht mehr — nur noch in ADR-0023 und im Betriebshandbuch. Ohne sie
          liest sich „springt nicht ein" wie ein Widerspruch zu der Einladung,
          die kurz vorher angekommen ist.
        */
        note="Aus heißt: diese Organisation sendet keine E-Mails aus ihren Formularen. Der Mailserver der Installation springt dafür nicht ein — er gehört dem Betrieb. Nur Kontomails wie eine Einladung gehen über ihn, und das ist Absicht."
        checked={draft.enabled}
        onChange={(enabled) => {
          setDraft({ ...draft, enabled });
        }}
      >
        <TextSetting
          label="Host"
          value={draft.host}
          variant="mono"
          issue={issues['smtp.host']}
          onChange={(host) => {
            setDraft({ ...draft, host });
          }}
        />

        <div className="tenant-admin__mail-grid">
          <TextSetting
            label="Port"
            value={draft.port}
            variant="mono"
            issue={issues['smtp.port']}
            onChange={(port) => {
              setDraft({ ...draft, port });
            }}
          />
          <TextSetting
            label="Absenderadresse"
            value={draft.from}
            variant="mono"
            issue={issues['smtp.from']}
            onChange={(from) => {
              setDraft({ ...draft, from });
            }}
          />
        </div>

        <ToggleSetting
          title="Implizites TLS (smtps)"
          description="Aus für STARTTLS (meist Port 587), an für eine von Anfang an verschlüsselte Verbindung (meist Port 465)."
          checked={draft.secure}
          onChange={(secure) => {
            setDraft({ ...draft, secure });
          }}
        />

        <ToggleSetting
          title="Anmeldung erforderlich"
          note="Aus für einen Relay, der ohne Zugangsdaten sendet – ein unterstützter Betriebsmodus, keine Notlösung."
          checked={draft.authEnabled}
          onChange={(authEnabled) => {
            setDraft({
              ...draft,
              authEnabled,
              password: { kind: 'keep' },
            });
          }}
        >
          <TextSetting
            label="Benutzername"
            value={draft.user}
            variant="mono"
            issue={usernameIssue}
            onChange={(user) => {
              setDraft({ ...draft, user });
            }}
          />

          <div className="setting__field">
            <label
              className="setting__label"
              htmlFor="tenant-admin-mail-password"
            >
              Passwort ersetzen
            </label>
            <input
              className="setting__control setting__control--mono"
              id="tenant-admin-mail-password"
              type="password"
              value={passwordText}
              placeholder={
                hadPassword
                  ? '•••••••• (unverändert)'
                  : 'kein Passwort hinterlegt'
              }
              onChange={(event) => {
                const value = event.target.value;
                setDraft({
                  ...draft,
                  password:
                    value === '' ? { kind: 'keep' } : { kind: 'set', value },
                });
              }}
            />
            {issues['smtp.auth.password'] !== undefined ? (
              <p className="settings__alert" role="alert">
                {issues['smtp.auth.password']}
              </p>
            ) : (
              <p className="tenant-admin__readonly">
                {hadPassword
                  ? 'Passwort ist gesetzt. Leer lassen, um es unverändert zu behalten.'
                  : 'Kein Passwort hinterlegt – zum Einrichten wird eines benötigt.'}
              </p>
            )}
          </div>
        </ToggleSetting>
      </ToggleSetting>
    </>
  );
}
