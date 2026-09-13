import type { ReactElement } from 'react';

import { ApiError } from '../../api/http';
import { useSession } from '../../api/session';
import {
  useSaveSystemMailSettings,
  useSendSystemTestMail,
  useSystemMailSettings,
} from '../../api/system-settings';
import { useServerDraft } from '../../hooks/use-server-draft';
import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { TestMailCard } from '../settings/TestMailCard';
import {
  SystemAddressesCard,
  SystemBaseUrlCard,
  SystemMailServerCard,
} from './SystemMailCards';
import { saveErrorMessage, fieldIssues } from '../api-messages';
import {
  systemMailDirty,
  systemMailDraftOf,
  systemMailWriteOf,
  type SystemMailDraft,
} from './system-mail-draft';

import '../settings-view.css';
import './system-mail-settings.css';

/**
 * There is exactly **one** system row, so the draft's key is a constant —
 * the same reasoning the organisation's own settings draft key gives.
 */
const SYSTEM_MAIL_DRAFT_KEY = 'system-mail';

const MISSING_MAIL_SUBJECT = {
  changed: 'Der Mailserver und die Basis-Adresse wurden',
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
};

/**
 * *Mailserver & Basis-Adresse* — the mail server **of the instance** and its
 * address (the tab *Mailserver* of the system administration; ADR-0013,
 * ADR-0023).
 *
 * ## Whom this mail server serves — and whom it does not (ADR-0023)
 *
 * It is the mail server of the **operator**: the operations alerts (ADR-0016)
 * and the test mail of this tab go out over it. It is **no** replacement for a
 * missing mail server of an organisation — an organisation without its own
 * sends nothing instead of dispatching foreign post under the SPF/DKIM
 * authorisation of this installation. The texts on this page say so, because
 * they said the opposite before („wenn eine Organisation keinen eigenen
 * hinterlegt hat").
 *
 * **Two values, and they are deliberately not one control.** The SMTP block
 * is switched on or off as a whole — a half-configured server is not
 * expressible on this page any more than it is on the wire
 * (`systemSmtpWriteSchema`) — while the base address is its own field,
 * settable and clearable on its own (ADR-0013 no. 3). Neither being absent is
 * an error state here: „kein Mailserver eingerichtet" is the state every
 * fresh installation starts in, and the page says so rather than nagging.
 *
 * **The password is never shown, never round-tripped.** Its field carries
 * only what the OIDC client secret's own field carries — „gesetzt" or „nicht
 * gesetzt" as a placeholder — and leaving it untouched sends nothing at all,
 * which is what keeps a host- or port-only edit from clearing a working
 * password (the requirement's second reproduction; `system-mail-draft.ts`).
 *
 * ## The test-mail section (finding 29a)
 *
 * This page could set up the mail server of the installation and not check it.
 * The only test-mail button hung off the active organisation, so it went over
 * that organisation's block — and it hit the system block only by chance,
 * namely exactly when this organisation happened to be inheriting. The section
 * here calls `POST /admin/system-settings/mail/test`, and this route explicitly
 * demands the system block; it does not see the `smtp` column of the
 * organisation at all.
 *
 * The section is the same one as in the tenant administration
 * (`../settings/TestMailCard.tsx`) — there are two buttons in this application
 * that really send, and two versions of the same section would be two error
 * evaluations, one of which drifts off.
 *
 * **It stands under the mail-server section and not under the base address**,
 * because it checks the mail server: what it answers is "does this server
 * accept a mail", not "is the address in the links right".
 */
export function SystemMailSettingsTab(): ReactElement | null {
  const mail = useSystemMailSettings();
  const save = useSaveSystemMailSettings();
  const testMail = useSendSystemTestMail();
  // Only for the default „an mich selbst" and its label. The server decides
  // the recipient; this line labels the default, it does not set it.
  const session = useSession();

  const document = mail.data;

  const { draft, setDraft, beginSave } = useServerDraft<SystemMailDraft>(
    SYSTEM_MAIL_DRAFT_KEY,
    document === undefined ? undefined : systemMailDraftOf(document.values),
  );

  if (mail.isPending) {
    return (
      <p className="settings__state" role="status">
        Mailserver & Basis-Adresse werden geladen…
      </p>
    );
  }

  if (mail.data === undefined) {
    if (mail.error instanceof ApiError && mail.error.status === 403) {
      // The navigation entry is already hidden for anyone without the
      // superadmin flag; this is the boundary itself, not a second gate
      // (`CONTRIBUTING.md`).
      return (
        <p className="settings__state" role="alert">
          Diese Ansicht ist Superadmins vorbehalten.
        </p>
      );
    }
    return (
      <p className="settings__state" role="alert">
        Mailserver & Basis-Adresse konnten nicht geladen werden. Bitte die Seite
        neu laden.
      </p>
    );
  }

  if (document === undefined || draft === null) {
    return null;
  }

  const issues = fieldIssues(save.error);
  const dirty = systemMailDirty(document.values, draft);
  /*
    Ob es überhaupt eine Organisation gibt, in deren Versandprotokoll der
    Versuch abgelegt werden könnte (Review-Runde 3 Nr. 12). Aus der Sitzung
    und nicht aus einer eigenen Abfrage: dieselbe Auskunft, die der Server für
    die Route selbst heranzieht.
  */
  const hasTenant =
    session.data !== null && session.data?.activeTenantId !== null;
  // `document.values.smtp?.authUser !== null` looks equivalent and is not:
  // when `smtp` itself is `null` (no mail server set up at all), the
  // optional-chain reads `undefined`, and `undefined !== null` is `true` —
  // exactly the fresh-installation state the e2e walkthrough's Schritt 1
  // begins from, where this used to claim a password was already set.
  // `smtp` has to be checked first.
  const hadPassword =
    document.values.smtp !== null && document.values.smtp.authUser !== null;

  return (
    <>
      <SystemMailServerCard
        draft={draft}
        setDraft={setDraft}
        issues={issues}
        hadPassword={hadPassword}
      />

      <TestMailCard
        heading="Testmail"
        headingId="system-mail-test-heading"
        hint={
          <>
            Prüft den <strong>Mailserver dieser Instanz</strong> mit einer
            echten E-Mail – nie den einer Organisation. Geprüft wird, was
            gespeichert ist, nicht der eingetippte Entwurf.
            {hasTenant
              ? ' Der Versuch steht danach im Versandprotokoll der ausgewählten Organisation, weil jede Protokollzeile zu einer gehört.'
              : ''}
          </>
        }
        currentUserEmail={session.data?.email ?? ''}
        blockedReason={
          dirty
            ? 'Es gibt ungespeicherte Änderungen. Bitte zuerst speichern, um den gespeicherten Mailserver zu testen.'
            : null
        }
        /*
          **Ohne Organisation geht es trotzdem — nur ohne Eintrag**
          (Review-Runde 3 Nr. 12). Bis dahin war „keine Organisation
          ausgewählt" hier ein 403, obwohl die Berechtigung nie die Frage war:
          es ging allein um die Zeile im Versandprotokoll, und die gehört
          immer einer Organisation.
        */
        logged={hasTenant}
        send={testMail}
        forbiddenMessage="Testmail nicht möglich: Dafür braucht es Superadmin-Rechte."
      />

      <SystemBaseUrlCard draft={draft} setDraft={setDraft} issues={issues} />

      <SystemAddressesCard draft={draft} setDraft={setDraft} issues={issues} />

      <SettingsSaveBar
        isSaving={save.isPending}
        dirty={dirty}
        onSave={() => {
          save.mutate(systemMailWriteOf(draft, document.lock), {
            onSuccess: beginSave(),
          });
        }}
      />

      {save.isError ? (
        <p className="settings__alert" role="alert">
          {saveErrorMessage(save.error, MISSING_MAIL_SUBJECT)}
        </p>
      ) : null}
    </>
  );
}
