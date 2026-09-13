import type { ReactElement } from 'react';
import { useState } from 'react';
import type { Superadmin } from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useDemoteSuperadmin,
  usePromoteSuperadmin,
  useSuperadmins,
} from '../../api/superadmins';
import { actionErrorMessage, fieldIssues } from '../api-messages';
import { initials } from '../initials';
import { ConfirmPrompt } from '../tenant-admin/ConfirmPrompt';

import '../settings-view.css';

/**
 * *System administration* — **who carries it** (ADR-0029).
 *
 * ## Why this tab exists
 *
 * Because up to this point there was none. An installation got its first
 * superadministrator via the setup wizard or
 * `scripts/create-superadmin.sh` and a **second** one via nothing at all: both
 * paths demand *zero* rows in `user` (ADR-0022 §3). Whoever lost the one
 * access — password gone, person left — could only get to the administration
 * of their own installation through `psql`.
 *
 * ## The shape comes from the person list of an organisation
 *
 * `TenantMembersTab` one level down: a list, below it a form, in every row the
 * action with its confirmation prompt. What is **missing** is the role
 * selection — `is_superadmin` is a boolean and not a ranking, there is
 * nothing one could demote to.
 *
 * ## Why an address is typed instead of picked from a list
 *
 * Because the list does not exist and is not meant to. A select field over all
 * persons of the installation would be a cross-organisation
 * directory of people — exactly the piece of information this application
 * defends everywhere else: the superadmin surface reads **nothing** of an
 * organisation's business, its members included (`AdminRepository`,
 * `SuperadminsService`). An address is what a human knows of another
 * person anyway.
 *
 * ## Nothing here decides what the server decides
 *
 * The button „Ernennung zurücknehmen" stands on **every** row, on one's own
 * one as well and on the only one as well. The two refusals — the last
 * superadministrator, and an account that is a member of no organisation —
 * come as a 409 with the server's sentence, and that then stands in the row.
 * A surface that forbids more than the server lies about the rule; the same
 * reasoning is what `MemberRow` writes out.
 */
export function SystemSuperadminsTab({
  currentUserId,
}: {
  /**
   * Who is watching right now — from `GET /auth/me`, never from a remembered
   * choice.
   *
   * Only for the badge „Du" and the wording of the confirmation prompt. **No
   * permission is derived from it**: that this person may read here at all was
   * decided by `SuperadminGuard`, and every refusal comes from the server.
   */
  readonly currentUserId: string;
}): ReactElement {
  const superadmins = useSuperadmins();

  const document_ = superadmins.data;

  if (superadmins.isPending) {
    return (
      <p className="settings__state" role="status">
        Systemverwaltung wird geladen…
      </p>
    );
  }

  if (document_ === undefined) {
    const forbidden =
      superadmins.error instanceof ApiError && superadmins.error.status === 403;
    return (
      <p className="settings__state" role="alert">
        {/*
          **Literally the sentence that every other superadmin view says**
          (`api-messages.ts`, `SystemMailSettingsTab`, `SuperadminView`). A
          wording of its own per tab reads like two applications — and it is
          the sentence by which the E2E run recognises the locked address.
        */}
        {forbidden
          ? 'Diese Ansicht ist Superadmins vorbehalten.'
          : 'Es konnte nicht geladen werden, wer das System verwaltet.'}
      </p>
    );
  }

  const list = document_.superadmins;

  return (
    <>
      <section className="settings-card" aria-labelledby="system-superadmins">
        <header className="settings-card__head">
          <div className="settings-card__text">
            <h2 className="settings-card__heading" id="system-superadmins">
              {list.length}{' '}
              {list.length === 1 ? 'Person verwaltet' : 'Personen verwalten'}{' '}
              das System
            </h2>
            <p className="settings-card__hint">
              Wer hier steht, sieht jede Organisation dieser Installation und
              darf sie anlegen und löschen. Das ist die weiteste Rechteerteilung
              dieser Anwendung — und sie sollte auf mindestens zwei Personen
              liegen, damit ein verlorener Zugang die Verwaltung nicht mitnimmt.
            </p>
          </div>
        </header>

        <ul className="settings-card__body system-superadmins__list">
          {list.map((entry) => (
            <SuperadminRow
              key={entry.userId}
              entry={entry}
              isYou={entry.userId === currentUserId}
            />
          ))}
        </ul>
      </section>

      <PromoteForm />
    </>
  );
}

/** A person who carries the system administration — with their one action. */
function SuperadminRow({
  entry,
  isYou,
}: {
  readonly entry: Superadmin;
  readonly isYou: boolean;
}): ReactElement {
  const demote = useDemoteSuperadmin();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="system-superadmins__row">
      <span className="system-superadmins__avatar" aria-hidden="true">
        {initials(entry.name)}
      </span>

      <div className="system-superadmins__text">
        <div className="system-superadmins__name">
          <span>{entry.name}</span>
          {isYou ? <span className="system-superadmins__badge">Du</span> : null}
        </div>
        <div className="system-superadmins__meta">{entry.email}</div>

        {/*
          **Two hints that exist nowhere else.** Both are pieces of information
          about the *account*, not about an organisation, and both decide
          something: the first, whether the withdrawal is possible at all; the
          second, who actually holds this appointment in their hand.
        */}
        {entry.hasMembership ? null : (
          <p className="setting__note setting__note--warning">
            In keiner Organisation Mitglied. Die Ernennung lässt sich deshalb
            nicht zurücknehmen — ohne sie hätte das Konto keinen Ort mehr und
            würde beim nächsten Aufräumlauf gelöscht.
          </p>
        )}
        {entry.invitationPending ? (
          <p className="setting__note setting__note--warning">
            Dieses Konto hat sich noch nie angemeldet. Wer den Einladungslink
            hat, verwaltet damit das System.
          </p>
        ) : null}
      </div>

      <button
        type="button"
        className="system-superadmins__revoke"
        aria-label={`Ernennung von ${entry.name} zurücknehmen`}
        disabled={demote.isPending}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Ernennung zurücknehmen
      </button>

      {confirming ? (
        <div className="system-superadmins__confirm">
          <ConfirmPrompt
            /*
              Two sentences for two cases: what one takes from oneself, one
              cannot give back to oneself — for that the second person is
              needed. With somebody else the way back is one click, and the
              sentence says exactly that, instead of claiming a drama that it
              does not have.
            */
            question={
              isYou
                ? 'Du nimmst dir selbst die Systemverwaltung. Sie gilt sofort nicht mehr — zurückgeben kann sie dir nur eine andere Person, die das System verwaltet.'
                : `„${entry.name}“ verwaltet das System danach nicht mehr. Konto und Mitgliedschaften bleiben; du kannst die Ernennung jederzeit wiederholen.`
            }
            confirmLabel="Ernennung zurücknehmen"
            tone="destructive"
            isPending={demote.isPending}
            onConfirm={() => {
              demote.mutate(entry.userId, {
                onSuccess: () => {
                  setConfirming(false);
                },
              });
            }}
            onCancel={() => {
              setConfirming(false);
            }}
          />
        </div>
      ) : null}

      {demote.isError ? (
        <p className="settings__alert system-superadmins__alert" role="alert">
          {actionErrorMessage(demote.error, {
            forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
            missing: 'Diese Person verwaltet das System nicht (mehr).',
            failed: 'Das ist fehlgeschlagen. Bitte erneut versuchen.',
          })}
        </p>
      ) : null}
    </li>
  );
}

/**
 * „Person zur Systemverwaltung hinzufügen".
 *
 * **An existing account** — the form has no name field and no role
 * selection, because it creates nobody. In this application an account always
 * comes into being together with a membership in an organisation
 * (`homeless-account.ts` lists the places); an account without an organisation
 * would be one that the cleanup run takes with it the moment somebody
 * withdraws the appointment.
 */
function PromoteForm(): ReactElement {
  const promote = usePromoteSuperadmin();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  /**
   * Was zuletzt geschehen ist — **ernannt oder eingeladen**
   * (Review-Runde 3 Nr. 13).
   *
   * Zwei verschiedene Sätze, weil zwei verschiedene Dinge geschehen sind: bei
   * einem vorhandenen Konto ändert sich eine Spalte, bei einer neuen Adresse
   * entsteht ein Konto **und** eine Mail geht hinaus. Und die kann scheitern,
   * ohne dass die Anfrage scheitert — sie geht an der Warteschlange vorbei,
   * es gibt also weder einen zweiten Versuch von selbst noch einen Eintrag,
   * in dem man später nachsähe.
   */
  const [justPromoted, setJustPromoted] = useState<{
    readonly name: string;
    readonly invited: boolean;
  } | null>(null);
  const issues = fieldIssues(promote.error);

  return (
    <section
      className="settings-card"
      aria-labelledby="system-superadmins-promote"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2
            className="settings-card__heading"
            id="system-superadmins-promote"
          >
            Person zur Systemverwaltung hinzufügen
          </h2>
          <p className="settings-card__hint">
            Hat die Person schon ein Konto, ändert sich daran nichts und auch
            nicht an ihren Organisationen — sie bekommt die Systemverwaltung
            dazu. Gibt es zu der Adresse noch <strong>kein</strong> Konto, wird
            eines angelegt und die Person eingeladen; sie vergibt ihr Passwort
            selbst und muss in <strong>keiner</strong> Organisation Mitglied
            sein.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <div className="setting__field">
          <label className="setting__label" htmlFor="system-superadmins-name">
            Name
          </label>
          <input
            className="setting__control"
            id="system-superadmins-name"
            type="text"
            autoComplete="off"
            value={name}
            aria-describedby="system-superadmins-name-note"
            aria-invalid={issues.name === undefined ? undefined : true}
            onChange={(event) => {
              setName(event.target.value);
              setJustPromoted(null);
            }}
          />
          <p className="setting__note" id="system-superadmins-name-note">
            Nur für eine <strong>neue</strong> Einladung — hat die Adresse schon
            ein Konto, bleibt dessen Name stehen.
          </p>
          {issues.name === undefined ? null : (
            <p className="setting__issue">{issues.name}</p>
          )}
        </div>

        <div className="setting__field">
          <label className="setting__label" htmlFor="system-superadmins-email">
            E-Mail-Adresse
          </label>
          <input
            className="setting__control"
            id="system-superadmins-email"
            type="email"
            value={email}
            aria-invalid={issues.email === undefined ? undefined : true}
            onChange={(event) => {
              setEmail(event.target.value);
              setJustPromoted(null);
            }}
          />
          {issues.email === undefined ? null : (
            <p className="setting__issue">{issues.email}</p>
          )}
        </div>

        <button
          type="button"
          className="settings__save"
          disabled={
            promote.isPending || email.trim() === '' || name.trim() === ''
          }
          onClick={() => {
            /*
              **Only trimmed, not lowercased** — the same thing the sign-in
              mask does with its address. The spelling is decided by
              `emailAddressSchema` (`packages/shared`), and decided on the
              server: a second normalisation here would be a second version of
              the same rule, and the one that drifts apart no longer finds the
              other one's row.
            */
            promote.mutate(
              { email: email.trim(), name: name.trim() },
              {
                onSuccess: (created) => {
                  setEmail('');
                  setName('');
                  setJustPromoted({
                    name: created.name,
                    invited: created.invited,
                  });
                },
              },
            );
          }}
        >
          {promote.isPending
            ? 'Wird hinzugefügt…'
            : 'Zur Systemverwaltung hinzufügen'}
        </button>

        {promote.isError ? (
          <p className="settings__alert" role="alert">
            {actionErrorMessage(promote.error, {
              forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
              /*
                **Kein `missing` mehr** (Review-Runde 3 Nr. 13): „Zu dieser
                Adresse gibt es kein Konto" ist seit dieser Runde kein
                Fehlschlag, sondern der Auslöser einer Einladung. Ein 404
                kommt von dieser Route nicht mehr; bliebe der Satz stehen,
                wäre er die eine Meldung, die nie erscheint und deshalb
                niemandem auffällt, wenn sie falsch wird.
              */
              conflict: 'Diese Person verwaltet das System bereits.',
              /*
                422 trägt den Satz des Servers (`actionErrorMessage`) — hier
                ist das die Absage der Einladung: kein Mailserver, keine
                Basis-Adresse, oder der Versand ist gescheitert. Alle drei
                nennen die Stelle, an der es zu beheben ist.
              */
              failed: 'Das ist fehlgeschlagen. Bitte erneut versuchen.',
            })}
          </p>
        ) : justPromoted === null ? null : (
          <p className="system-superadmins__flash" role="status">
            ✓ {justPromoted.name} verwaltet jetzt das System.
            {justPromoted.invited
              ? ' Das Konto wurde neu angelegt; die Einladung ist unterwegs, das Passwort vergibt die Person selbst.'
              : ''}
          </p>
        )}
      </div>
    </section>
  );
}
