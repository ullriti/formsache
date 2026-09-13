import { useId, useState, type ReactElement, type ReactNode } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { TestMailResult } from '@formsache/shared';

import type { TestMailVariables } from '../../api/tenant-admin';
import { actionErrorMessage } from '../api-messages';

import '../settings-view.css';

/**
 * **The test-mail section — written once, used by two tabs.**
 *
 * There are two buttons in this application that send a real mail over a
 * real mail server: one for the block of an Organisation
 * (*Organisations-Verwaltung → Mailversand*, `MailIdentityCard`) and, since finding 29a,
 * one for the block of the installation (*Systemeinstellungen → Mailserver &
 * Basis-Adresse*, `SystemMailSettingsTab`). They differ in exactly
 * two things — which route they call and which hint text they carry —
 * and in nothing that makes up this file: the address field, the default „an
 * mich selbst", the block, the evaluation of the response.
 *
 * Written twice, that would be the duplication for which `CONTRIBUTING.md`
 * cites `SandboxedHtmlFrame` as the example — and the half that drifted
 * would be the error evaluation, i.e. the one nobody looks at as long as everything
 * goes well.
 *
 * ## Why the address field starts empty and not with one's own address
 *
 * Empty means **„an mich selbst"**, and the hint under the field says which
 * address that is. Pre-filling the field with one's own address would be
 * the more obvious construction and the worse one: it would look like a value
 * somebody had set, and whoever deletes it by accident and saves
 * would get an empty request that means something other than what stood there.
 * This way the default case is the simple one — press the button, done — and the
 * deviating address a visible deviation.
 *
 * The value is **not** reused in the response: what stands on the
 * screen as the recipient is `result.recipientEmail` from the server. The
 * page never itself claims where the mail went (`testMailResultSchema`).
 *
 * ## The classes come from `settings-view.css`, and all of them do
 *
 * The first attempt took the classes over from the two callers —
 * `tenant-admin__readonly` here, `system-mail__readonly` there. Both are
 * **page-local** (`tenant-admin-view.css` and `system-mail-settings.css`
 * respectively), and a shared section that uses them would look different on
 * the other page. That it nevertheless goes well in the built bundle — Vite puts
 * all stylesheets into one file — does not make the coupling more correct,
 * only invisible. This file therefore brings its stylesheet along itself
 * and uses only classes from it.
 */
export interface TestMailCardProps {
  /** Heading of the section — both tabs call it „Testmail". */
  readonly heading: string;
  /** The id for `aria-labelledby`; unique per page. */
  readonly headingId: string;
  /** What is being checked, in one sentence — the only real difference. */
  readonly hint: ReactNode;
  /** One's own address, for the default „an mich selbst". */
  readonly currentUserEmail: string;
  /**
   * Why the button is currently not allowed, or `null`.
   *
   * A **sentence**, not a `boolean`: a button that is greyed out without a
   * reason is the dead end that `MailIdentityCard` expressly avoids for the
   * `dirty` case.
   */
  readonly blockedReason: string | null;
  /**
   * Ob dieser Versand im Versandprotokoll landet (Review-Runde 3 Nr. 12).
   *
   * `false` gibt es genau einmal: die Testmail der Systemverwaltung, ausgelöst
   * von jemandem **ohne** Organisation. Jede Zeile des Versandprotokolls
   * gehört einer Organisation (`mail_log.tenant_id` ist `NOT NULL`), also gibt
   * es dann keine — die Mail geht trotzdem hinaus.
   *
   * Ein Pflichtfeld und keine Vorgabe: „wird das mitgeschrieben?" ist eine
   * Aussage über den Versand, die beide Aufrufer beantworten können und
   * müssen. Ein `?? true` hier hieße, dass die eine Stelle, die es nicht tut,
   * still die falsche Auskunft gäbe.
   */
  readonly logged: boolean;
  /**
   * **Vor dem Senden speichern** — oder `undefined` (Review-Runde 4 Nr. 3).
   *
   * Der Vorschlag lautete wörtlich: *„Testmail im Wizard: Vielleicht den
   * Button so: ‚Speichern und Testmail senden'?"* Er löst einen Befund auf,
   * den Runde 3 nur halb erledigt hatte. Die Testmail prüft, was
   * **gespeichert** ist — richtig so —, und der Weg dorthin war zuletzt: den
   * Zweitknopf „Speichern" unten drücken, dann hier oben den gesperrten Knopf,
   * der inzwischen aufgegangen ist. Zwei Knöpfe an zwei Enden der Seite für
   * eine Handlung.
   *
   * Mit dieser Funktion ist es eine: der Knopf heißt „Speichern und Testmail
   * senden", speichert und sendet danach. Die Sperre entfällt damit ebenfalls
   * — es gibt keinen ungespeicherten Zustand mehr, in dem das Senden falsch
   * wäre.
   *
   * ⚠️ **Nur im Assistenten.** In den beiden Verwaltungs-Reitern bleibt es beim
   * bloßen „Testmail senden": dort steht der Speichern-Knopf des Blocks
   * unmittelbar über der Karte, und ein zweiter Weg zu speichern wäre eine
   * zweite Wahrheit darüber, was der Reiter gerade hält.
   */
  readonly saveFirst?:
    | {
        /** Speichert und ruft `onSaved` **nur bei Erfolg** auf. */
        readonly run: (onSaved: () => void) => void;
        readonly pending: boolean;
      }
    | undefined;
  /** The action — `useSendTestMail` or `useSendSystemTestMail`. */
  readonly send: UseMutationResult<TestMailResult, Error, TestMailVariables>;
  /** What a 403 on this route means; the roles differ per route. */
  readonly forbiddenMessage: string;
}

export function TestMailCard({
  heading,
  headingId,
  hint,
  currentUserEmail,
  blockedReason,
  logged,
  saveFirst,
  send,
  forbiddenMessage,
}: TestMailCardProps): ReactElement {
  const fieldId = useId();
  const [recipient, setRecipient] = useState('');

  const trimmed = recipient.trim();
  // Empty means „an mich selbst" — and `null` is the spelling that says that on
  // the wire (`testMailRequestSchema`). An empty string would be
  // no address and would get a 400 where the user did nothing wrong.
  const recipientEmail = trimmed === '' ? null : trimmed;

  return (
    <section className="settings-card" aria-labelledby={headingId}>
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id={headingId}>
            {heading}
          </h2>
          <p className="settings-card__hint">{hint}</p>
        </div>
      </header>

      <div className="settings-card__body">
        {blockedReason === null ? null : (
          <p className="settings__note">{blockedReason}</p>
        )}

        {/*
          **Der Verlust wird benannt, nicht verschwiegen** (Review-Runde 3
          Nr. 12). Ohne Organisation geht die Mail hinaus und hinterlässt
          keine Spur: kein Eintrag im Versandprotokoll, kein „↻ Erneut", und
          die Fehlermeldung unten ist alles, was von einem Fehlschlag bleibt.
          Wer das erst hinterher merkt, sucht den Eintrag an einer Stelle, an
          der es ihn nie geben wird.

          `role="status"` und nicht `alert`: es ist kein Fehler, sondern eine
          Eigenschaft dieses Zustands.
        */}
        {logged ? null : (
          <p className="settings__note" role="status">
            Diese Installation hat noch keine Organisation, und jede Zeile des
            Versandprotokolls gehört einer. Der Versand geht trotzdem hinaus —{' '}
            <strong>nur nachlesen lässt er sich hinterher nicht</strong>. Was
            hier unten steht, ist alles, was von diesem Versuch bleibt.
          </p>
        )}

        <div className="setting__field">
          <label className="setting__label" htmlFor={fieldId}>
            Empfänger (optional)
          </label>
          <input
            className="setting__control setting__control--mono"
            id={fieldId}
            type="email"
            value={recipient}
            placeholder={currentUserEmail}
            aria-describedby={`${fieldId}-note`}
            onChange={(event) => {
              setRecipient(event.target.value);
              /*
                **The response belongs to the address that stood there** (review
                finding 13). „✓ Testmail an a@example.org gesendet" stayed standing
                while somebody rewrote it next to it to b@example.org — a
                success message above a field that says something else, and the
                next press of the button would be indistinguishable, for the reader, from the
                previous response. The same pattern with which
                `ProfileView` takes back its `setSaved(false)` on typing.
              */
              send.reset();
            }}
          />
          <p className="settings__note" id={`${fieldId}-note`}>
            {/*
              Without a known address of one's own the sentence stays **true rather
              than complete**: „(…)" with nothing in it would be a bracket that
              looks like an error. Reachable as long as the session
              is not loaded.
            */}
            {currentUserEmail === ''
              ? 'Leer lassen, um an die eigene Adresse zu senden.'
              : `Leer lassen, um an die eigene Adresse zu senden (${currentUserEmail}).`}{' '}
            Eine andere Adresse ist möglich –{' '}
            {logged
              ? 'der Versand steht mit dieser Adresse im Versandprotokoll.'
              : 'dieser Versuch wird nicht protokolliert.'}
          </p>
        </div>

        <button
          type="button"
          className="settings__save"
          disabled={
            blockedReason !== null ||
            send.isPending ||
            saveFirst?.pending === true
          }
          onClick={() => {
            if (saveFirst === undefined) {
              send.mutate({ recipientEmail });
              return;
            }
            /*
              Erst speichern, dann senden — und **nur bei Erfolg**. Wird die
              Ablehnung nicht abgewartet, prüfte die Mail den vorherigen Stand
              und meldete Erfolg über einen Server, den niemand hinterlegt hat.
              Ein `onSaved`, das der Aufrufer im Fehlerfall nicht ruft, ist die
              billigere Hälfte dieser Zusage; die teurere ist, dass die
              Ablehnung oben am Assistenten steht, wo sie hingehört.
            */
            saveFirst.run(() => {
              send.mutate({ recipientEmail });
            });
          }}
        >
          {saveFirst?.pending === true
            ? 'Wird gespeichert…'
            : send.isPending
              ? 'Wird gesendet…'
              : saveFirst === undefined
                ? 'Testmail senden'
                : 'Speichern und Testmail senden'}
        </button>

        {send.isError ? (
          <p className="settings__alert" role="alert">
            {actionErrorMessage(send.error, {
              forbidden: forbiddenMessage,
              failed: 'Testmail fehlgeschlagen. Bitte erneut versuchen.',
            })}
          </p>
        ) : send.data !== undefined ? (
          send.data.status === 'sent' ? (
            <p className="settings__save-state" role="status">
              ✓ Testmail an {send.data.recipientEmail} gesendet.
            </p>
          ) : (
            <p className="settings__alert" role="alert">
              Testmail fehlgeschlagen
              {send.data.reason !== null ? `: ${send.data.reason}` : '.'}
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}
