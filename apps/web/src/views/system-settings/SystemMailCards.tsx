import type { ReactElement } from 'react';

import {
  TextSetting,
  ToggleSetting,
  type SettingIssues,
} from '../settings/SettingsControls';
import type { SystemMailDraft } from './system-mail-draft';

import '../settings-view.css';
import './system-mail-settings.css';

/**
 * **The three cards of the mail tab, individually** — mail server, base
 * address, addresses.
 *
 * Until the setup assistant (ADR-0022, continuation 2026-08-18) all three of
 * them stood in the body of `SystemMailSettingsTab`. The assistant
 * leads through **the same** settings, but in three separate steps:
 * the base address (step 2), the mail server (step 3) and the two
 * addresses (step 4). Copying them here would mean maintaining the same hint
 * texts twice — and the assistant is exactly the page nobody calls up any more
 * to notice that they have drifted apart.
 *
 * Pure and controlled, like the building blocks in `settings/`: no hook, no
 * route, no loading. What they have in common is the draft
 * ({@link SystemMailDraft}) — and in the tab that is **one** document with
 * **one** counter, which is why the assistant's three steps also save one
 * after another on the same document.
 */

export interface SystemMailCardProps {
  readonly draft: SystemMailDraft;
  readonly setDraft: (next: SystemMailDraft) => void;
  readonly issues: SettingIssues;
}

export interface SystemMailServerCardProps extends SystemMailCardProps {
  /**
   * Whether a password is stored.
   *
   * ⚠️ `document.values.smtp?.authUser !== null` looks equivalent and is not:
   * if `smtp` itself is `null` (no mail server set up at all), the optional
   * chain reads `undefined`, and `undefined !== null` is `true`
   * — exactly the state of a fresh installation in which this page claimed one
   * was already stored. That is why it is a parameter and not a derivation in
   * two places.
   */
  readonly hadPassword: boolean;
}

/** *Mailserver* — the instance's SMTP block, whole or not at all. */
export function SystemMailServerCard({
  draft,
  setDraft,
  issues,
  hadPassword,
}: SystemMailServerCardProps): ReactElement {
  const passwordText =
    draft.password.kind === 'set' ? draft.password.value : '';

  return (
    <section
      className="settings-card"
      aria-labelledby="system-mail-smtp-heading"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="system-mail-smtp-heading">
            Mailserver
          </h2>
          <p className="settings-card__hint">
            Der SMTP-Server dieser Instanz – für Betriebsmeldungen an die
            Betreiberadresse und für die Testmail auf dieser Seite.
            Organisationen senden <strong>nicht</strong> darüber; jede
            Organisation trägt ihren eigenen Mailserver ein. Host, Port,
            Verschlüsselung, Anmeldung und Absenderadresse gehören zusammen —
            ein halb ausgefüllter Block lässt sich nicht speichern.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <ToggleSetting
          title="Mailserver eingerichtet"
          note="Ohne ihn erreichen Betriebsmeldungen niemanden und die Testmail unten geht nicht hinaus – die Anwendung läuft normal weiter, und die Organisationen senden über ihre eigenen Mailserver."
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

          <div className="system-mail__grid">
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
              issue={issues['smtp.auth.user']}
              onChange={(user) => {
                setDraft({ ...draft, user });
              }}
            />

            <TextSetting
              label="Passwort ersetzen"
              value={passwordText}
              variant="mono"
              type="password"
              placeholder={
                hadPassword
                  ? '•••••••• (unverändert)'
                  : 'kein Passwort hinterlegt'
              }
              issue={issues['smtp.auth.password']}
              note={
                hadPassword
                  ? 'Passwort ist gesetzt. Leer lassen, um es unverändert zu behalten.'
                  : 'Kein Passwort hinterlegt – zum Einrichten eines neuen Mailservers wird eines benötigt.'
              }
              onChange={(value) => {
                setDraft({
                  ...draft,
                  password:
                    value === '' ? { kind: 'keep' } : { kind: 'set', value },
                });
              }}
            />
          </ToggleSetting>
        </ToggleSetting>
      </div>
    </section>
  );
}

export interface SystemBaseUrlCardProps extends SystemMailCardProps {
  /**
   * A sentence **under the field** that stands only in the assistant.
   *
   * There the base address is prefilled from `window.location.origin`, and
   * exactly that has to be said along with it: behind a reverse proxy the
   * address the browser sees is not necessarily the one that belongs in a
   * mail. On the tab nothing is prefilled, so there is nothing to explain
   * there either — the sentence is therefore a parameter and not an `if` in
   * this card.
   */
  readonly prefillNote?: string | undefined;
}

/** *Basis-Adresse* — where this installation is reachable from outside. */
export function SystemBaseUrlCard({
  draft,
  setDraft,
  issues,
  prefillNote,
}: SystemBaseUrlCardProps): ReactElement {
  return (
    <section
      className="settings-card"
      aria-labelledby="system-mail-base-url-heading"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2
            className="settings-card__heading"
            id="system-mail-base-url-heading"
          >
            Basis-Adresse
          </h2>
          <p className="settings-card__hint">
            Wo diese Installation von außen erreichbar ist – die Grundlage für
            Links in Bestätigungsmails. Hat mit dem Mailserver nichts zu tun:
            eine Organisation kann unter eigener Adresse erreichbar sein, ganz
            unabhängig davon, über welchen Mailserver sie sendet.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <TextSetting
          label="Basis-Adresse"
          value={draft.publicBaseUrl}
          placeholder="https://formulare.example.org"
          variant="mono"
          issue={issues.publicBaseUrl}
          note={prefillNote}
          noteTone={prefillNote === undefined ? 'plain' : 'warning'}
          onChange={(publicBaseUrl) => {
            setDraft({ ...draft, publicBaseUrl });
          }}
        />
        <p className="system-mail__readonly">
          Fehlt sie, bleibt ein Bearbeiten-Link in einer Mail unaufgelöst, statt
          auf eine geratene Adresse zu zeigen.
        </p>
      </div>
    </section>
  );
}

/** *Antwortadresse* and *Betreiberadresse* — two addresses, no secret. */
export function SystemAddressesCard({
  draft,
  setDraft,
  issues,
}: SystemMailCardProps): ReactElement {
  return (
    <section
      className="settings-card"
      aria-labelledby="system-mail-reply-to-heading"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2
            className="settings-card__heading"
            id="system-mail-reply-to-heading"
          >
            Antwortadresse
          </h2>
          <p className="settings-card__hint">
            Wohin Antworten auf verschickte Mails gehen sollen, wenn eine
            Organisation und eine Benachrichtigung nichts eigenes hinterlegt
            haben. Steht bewusst neben dem Mailserver: sie ist kein Geheimnis
            und lässt sich deshalb ändern, ohne das SMTP-Passwort zur Hand zu
            haben.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <TextSetting
          label="Antwortadresse"
          value={draft.replyTo}
          placeholder="geschaeftsstelle@example.org"
          variant="mono"
          issue={issues.replyTo}
          onChange={(replyTo) => {
            setDraft({ ...draft, replyTo });
          }}
        />
        <p className="system-mail__readonly">
          Leer lassen, wenn es keine Vorgabe geben soll. Dann trägt eine Mail
          keine Antwortadresse, und eine Antwort geht – wie üblich – an die
          Absenderadresse.
        </p>

        {/*
          ⚠️ This field is a review's find: the column existed and so did the
          watch — but **no write path**. On every real installation the alarm
          reported „keine Adresse konfiguriert" and sent
          nothing.
        */}
        <TextSetting
          label="Betreiberadresse für Betriebsalarme"
          value={draft.opsAlertEmail}
          placeholder="betrieb@example.org"
          variant="mono"
          issue={issues.opsAlertEmail}
          onChange={(opsAlertEmail) => {
            setDraft({ ...draft, opsAlertEmail });
          }}
        />
        <p className="system-mail__readonly">
          Dorthin meldet sich die Anwendung, wenn eine Schwelle reißt – gestaute
          Post, ein ausbleibender Aufräumlauf, eine volle Ablage. Leer heißt{' '}
          <em>niemand</em>: die Zahlen stehen dann weiterhin unter
          <em> Verwaltung → Betrieb</em>, aber von selbst meldet sich nichts.
          Eine Adresse, kein Verteiler – wer mehrere Empfänger will, trägt eine
          Verteileradresse ein.
        </p>
        <p className="system-mail__readonly">
          ⚠️ Ein toter Mailserver kann seinen eigenen Ausfall nicht melden.
          Genau dafür gibt es den äußeren Beobachter (siehe Betriebshandbuch).
        </p>
      </div>
    </section>
  );
}
