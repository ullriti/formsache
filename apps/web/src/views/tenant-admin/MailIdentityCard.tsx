import type { ReactElement } from 'react';

import { useSendTestMail } from '../../api/tenant-admin';
import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { TestMailCard } from '../settings/TestMailCard';
import { MailIdentityFields } from './MailIdentityFields';
import { TenantBaseUrlCard } from './TenantBaseUrlCard';
import { TenantReplyToCard } from './TenantReplyToCard';
import { useTenantSmtpState } from './use-tenant-smtp';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * *Mailversand* — an organisation's mail server (ADR-0013, ADR-0023).
 *
 * ## There is nothing left to choose — only something to enter
 *
 * Two pills used to stand here: „Über den Mailserver des Systems" and „Eigener
 * Mailserver". The first one is gone (ADR-0023): an organisation no longer
 * inherits the installation's mail server, because that one belongs to the
 * operator and its domain is authorised via SPF/DKIM. What remains is a switch
 * — „Mailserver eingerichtet" — and the consequence when it is off stands as a
 * hint next to it instead of in a footnote: **this organisation then sends
 * nothing.**
 *
 * **Since ADR-0025 the fields stand in `MailIdentityFields`, the state in
 * `use-tenant-smtp.ts`** — the same cut the appearance got and for the same
 * reason: the second step of the organisation wizard shows the same card with
 * a different button underneath. What remains here is the composition of this
 * tab.
 *
 * **The base address is deliberately absent from this card.** ADR-0013 no. 3
 * is explicit that it is not part of the block — it says *where* an organisation is
 * reachable, not *who* it is in the mail system, so it is set and cleared
 * independently of `source`, through its own section of the same tab
 * (`TenantBaseUrlCard`) rather than a field bolted onto this document.
 *
 * ## The Testmail
 *
 * Tests the **stored** block, never the draft on screen — `POST
 * /tenant/smtp/test` carries no field a host or password could travel in
 * (`testMailRequestSchema` carries exactly one field, and that is an e-mail
 * address), so there is no second path for credentials to reach the
 * server past `PUT`. The button is therefore gated on `!dirty`: while the
 * draft differs from what is saved, the card says so and asks for a save
 * first, rather than showing a disabled button without a reason.
 *
 * **Since finding 29b the recipient may differ** — empty still means „to one's
 * own address", and the section says before the click which one that is.
 * The section itself is `TestMailCard` (`../settings/TestMailCard.tsx`),
 * shared with the system tab: there are two buttons in this application that
 * really send, and they should not drift apart.
 */
export function MailIdentityCard({
  tenantId,
  currentUserEmail,
}: {
  readonly tenantId: string;
  /**
   * The signed-in person's own address — where the Testmail goes. Named here rather than read via a second `useSession()`
   * call: `AppShell` already holds it and passes it down, the same way it
   * hands `currentUserId` to the *Nutzerrechte* tab.
   */
  readonly currentUserEmail: string;
}): ReactElement | null {
  const state = useTenantSmtpState(tenantId);
  const testMail = useSendTestMail();

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        Mailversand wird geladen…
      </p>
    );
  }

  if (state.kind === 'failed') {
    // The navigation entry is already visible only for those with
    // `canManageSettings`; this is the boundary itself, not a second gate
    // (`CONTRIBUTING.md`) — but `canViewResponses` is also required
    // (`smtp-config.controller.ts`), so a caller who may configure forms
    // but not read answers still meets a 403 here.
    return (
      <p className="settings__state" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <div className="tenant-admin__tab">
      <section
        className="settings-card"
        aria-labelledby="tenant-admin-mail-heading"
      >
        <header className="settings-card__head">
          <div className="settings-card__text">
            <h2
              className="settings-card__heading"
              id="tenant-admin-mail-heading"
            >
              Mailversand
            </h2>
            <p className="settings-card__hint">
              Über diesen Server verschickt diese Organisation ihre E-Mails.
              Host, Port, Verschlüsselung, Anmeldung und Absenderadresse gehören
              zusammen — ein halb ausgefüllter Block lässt sich nicht speichern.
              Wer nur die Absenderadresse ersetzen dürfte und weiter über einen
              fremden Server sendete, verschickte signierte Post unter einer
              fremden Adresse; das ist Identitätsfälschung, keine
              Konfigurationsunart.
            </p>
          </div>
        </header>

        <div className="settings-card__body">
          <MailIdentityFields
            draft={state.draft}
            setDraft={state.setDraft}
            issues={state.issues}
            unreadable={state.unreadable}
            hadPassword={state.hadPassword}
            usernameIssue={state.usernameIssue}
          />
        </div>

        <SettingsSaveBar
          isSaving={state.isSaving}
          dirty={state.dirty}
          onSave={() => {
            state.save();
          }}
        />

        {state.errorMessage === null ? null : (
          <p className="settings__alert" role="alert">
            {state.errorMessage}
          </p>
        )}
      </section>

      <TenantBaseUrlCard tenantId={tenantId} />

      {/*
        The third section next to the block, for the same reason as the
        second one: a reply-to address carries no secret, so it must not be
        chained to the SMTP password.
      */}
      <TenantReplyToCard tenantId={tenantId} />

      <TestMailCard
        heading="Testmail"
        headingId="tenant-admin-mail-test-heading"
        hint={
          <>
            Prüft den Mailversand dieser Organisation mit einer echten E-Mail –
            über den hier eingetragenen Mailserver. Geprüft wird, was{' '}
            <strong>gespeichert</strong> ist, nicht der gerade eingetippte
            Entwurf. Ist keiner eingetragen, sagt die Antwort genau das, und es
            wird nichts versucht.
          </>
        }
        currentUserEmail={currentUserEmail}
        blockedReason={
          state.dirty
            ? 'Es gibt ungespeicherte Änderungen. Bitte zuerst speichern, um die gespeicherte Konfiguration zu testen.'
            : null
        }
        // Immer protokolliert: diese Route läuft im Bereich einer
        // Organisation, und deren Versandprotokoll gibt es damit auch.
        logged
        send={testMail}
        forbiddenMessage="Diese Rolle darf keine Testmail senden."
      />
    </div>
  );
}
