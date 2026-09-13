import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  USER_PASSWORD_MAX,
  USER_PASSWORD_MIN,
  type SessionUser,
} from '@formsache/shared';

import { ApiError } from '../api/http';
import {
  useChangeOwnEmail,
  useChangeOwnPassword,
  useRevokeOtherSessions,
  useUpdateProfile,
} from '../api/session';
import { actionErrorMessage, fieldIssues } from './api-messages';

import './settings-view.css';

/**
 * **Mein Profil** — name, e-mail address, password and one's own sessions
 * (findings 8, 12 and 17).
 *
 * ## Why this page exists
 *
 * Up to this point nobody in this application could change their own password.
 * Creating an account worked, assigning a password worked — changing it
 * afterwards worked by no route at all, neither oneself nor through the
 * administration. That is the gap this page closes.
 *
 * ## Why „Passwort ändern" signs everything out here
 *
 * Because it does so on all three paths of this application (ADR-0020). One's
 * own login on *this* device is replaced by a fresh one — the answer
 * brings it along —, every other one ends. The reflex „ich ändere mein
 * Passwort" that somebody has after a noticed takeover thereby achieves
 * exactly what it is supposed to achieve.
 *
 * ## And why „Andere Sitzungen beenden" belongs here (finding 17)
 *
 * The button stood in the header navigation, between „Angemeldet als …" and
 * „Abmelden" — without context, without explanation, next to two things that
 * do nothing or end everything. It is right and was in the wrong place: it
 * answers the same question as the password change („mein Zugang ist
 * vielleicht kompromittiert"), and **next to** it, it makes sense. The order
 * on this page is that of the action: first change the password, then throw
 * out the devices that still have the old one.
 *
 * ## One's own e-mail address — here now, at a price (finding 8)
 *
 * For a long time it did not stand on this page, with the justification that
 * it is the sign-in key and that a change without confirmation of the new
 * address would mean being able to lock oneself out. The concern was serious
 * and the conclusion went too far: whoever changes the address is **signed in
 * here and stays so** — a typo costs a second attempt, no lockout, as long as
 * the session stands. And in the meantime this application had „Passwort
 * vergessen" (ADR-0020), that is, a way back over the mailbox.
 *
 * What the change costs instead is the **current password**, in the
 * same call. Not as a courtesy: an address change redirects the
 * login *and* every reset link to another mailbox — it is
 * the same takeover path against which the password change puts its own
 * query. Without it that one would be circumventable too: bend the address,
 * press „Passwort vergessen", read the mailbox.
 *
 * ## What deliberately still does **not** stand here
 *
 * A **session list**. The existing endpoint delivers a number and nothing
 * else (`sessionRevocationSchema`), and that is a decision with a
 * reason: which devices somebody uses would be a movement profile that this
 * application does not keep. This page therefore shows as much context as
 * the endpoint yields — the number, and a sentence that places it.
 */
export function ProfileView({
  user,
}: {
  readonly user: SessionUser;
}): ReactElement {
  return (
    <div className="settings">
      <div className="settings__head">
        <div className="settings__title-block">
          <h1 className="settings__title">Mein Profil</h1>
          <p className="settings__subtitle">
            Angemeldet als {user.email}
            {user.isSuperadmin ? ' · Systemverwaltung' : ''}
          </p>
        </div>
      </div>

      <NameCard user={user} />
      {/*
        **Both cards are there for an SSO account too, and that is deliberate.**
        `SessionUser` carries no „hat ein Passwort" field, and introducing one
        would be information about the sign-in kind in the document that
        renders the header. The server refuses an SSO account with 422 and a
        sentence of its own that the respective card displays — the surface is
        convenience, the boundary stands on the server.
      */}
      <EmailCard user={user} />
      <PasswordCard />
      <SessionsCard />
    </div>
  );
}

/** One's own name — the only field that is changeable without a query. */
function NameCard({ user }: { readonly user: SessionUser }): ReactElement {
  const update = useUpdateProfile();
  const [name, setName] = useState(user.name);
  const [saved, setSaved] = useState(false);
  const issues = fieldIssues(update.error);
  const dirty = name.trim() !== user.name;

  return (
    <section className="settings-card" aria-labelledby="profile-name">
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="profile-name">
            Name
          </h2>
          <p className="settings-card__hint">
            So erscheinst du in den Mitgliederlisten der Organisationen, in
            denen du arbeitest.
          </p>
        </div>
      </header>

      {/*
        **The body is the padding.** `.settings-card` itself has none —
        whoever hangs their fields straight into it sticks them to the card's
        edge, and that is exactly what the three cards of this page did
        (finding 6). The same structure as in every other settings card, for
        instance `tenant-admin/MailIdentityCard`.
      */}
      <div className="settings-card__body">
        <div className="setting__field">
          <label className="setting__label" htmlFor="profile-name-input">
            Name
          </label>
          <input
            className="setting__control"
            id="profile-name-input"
            type="text"
            value={name}
            aria-invalid={issues.name === undefined ? undefined : true}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
          />
          {issues.name === undefined ? null : (
            <p className="setting__issue">{issues.name}</p>
          )}
        </div>

        <div className="settings__actions">
          <button
            type="button"
            className="settings__save"
            disabled={update.isPending || !dirty}
            onClick={() => {
              update.mutate(name.trim(), {
                onSuccess: () => {
                  setSaved(true);
                },
              });
            }}
          >
            {update.isPending ? 'Wird gespeichert…' : 'Namen speichern'}
          </button>
        </div>

        {update.isError ? (
          <p className="settings__alert" role="alert">
            {actionErrorMessage(update.error, {
              forbidden: 'Dieser Name kann nicht gespeichert werden.',
              failed: 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
            })}
          </p>
        ) : saved ? (
          <p className="settings__notice" role="status">
            ✓ Dein Name wurde gespeichert.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One's own **e-mail address** — with the password asked for (finding 8).
 *
 * A card of its own and not a second field in the name card: the two
 * actions have two prices, and a shared „Speichern" button
 * would demand a password for a corrected typo in a first name. The
 * server separates them into two routes for the same reason (`POST /auth/email`
 * next to `PUT /auth/profile`).
 */
function EmailCard({ user }: { readonly user: SessionUser }): ReactElement {
  const change = useChangeOwnEmail();
  const [email, setEmail] = useState(user.email);
  const [current, setCurrent] = useState('');
  const [saved, setSaved] = useState(false);

  const issues = fieldIssues(change.error);
  const trimmed = email.trim();
  const dirty = trimmed.toLowerCase() !== user.email;
  const ready = dirty && current !== '';

  return (
    <section className="settings-card" aria-labelledby="profile-email">
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="profile-email">
            E-Mail-Adresse ändern
          </h2>
          <p className="settings-card__hint">
            Mit dieser Adresse meldest du dich an, und an sie geht ein „Passwort
            vergessen"-Link. Deshalb fragt die Änderung nach deinem aktuellen
            Passwort. Deine Anmeldung hier bleibt bestehen; offene
            Rücksetz-Links an die alte Adresse verfallen.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <div className="setting__field">
          <label className="setting__label" htmlFor="profile-email-input">
            Neue E-Mail-Adresse
          </label>
          <input
            className="setting__control"
            id="profile-email-input"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={issues.email === undefined ? undefined : true}
            onChange={(event) => {
              setEmail(event.target.value);
              setSaved(false);
            }}
          />
          {issues.email === undefined ? null : (
            <p className="setting__issue">{issues.email}</p>
          )}
        </div>

        <div className="setting__field">
          <label
            className="setting__label"
            htmlFor="profile-email-current-password"
          >
            Aktuelles Passwort
          </label>
          <input
            className="setting__control"
            id="profile-email-current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            aria-invalid={
              issues.currentPassword === undefined ? undefined : true
            }
            onChange={(event) => {
              setCurrent(event.target.value);
              setSaved(false);
            }}
          />
          {issues.currentPassword === undefined ? null : (
            <p className="setting__issue">{issues.currentPassword}</p>
          )}
        </div>

        <div className="settings__actions">
          <button
            type="button"
            className="settings__save"
            disabled={change.isPending || !ready}
            onClick={() => {
              change.mutate(
                { currentPassword: current, email: trimmed },
                {
                  onSuccess: () => {
                    // The password leaves the field as soon as it has been
                    // used — otherwise it stands in the form until the next
                    // page change.
                    setCurrent('');
                    setSaved(true);
                  },
                },
              );
            }}
          >
            {change.isPending ? 'Wird geändert…' : 'Adresse ändern'}
          </button>
        </div>

        {change.isError ? (
          <p className="settings__alert" role="alert">
            {emailErrorMessage(change.error)}
          </p>
        ) : saved ? (
          <p className="settings__notice" role="status">
            ✓ Deine E-Mail-Adresse wurde geändert. Melde dich künftig mit{' '}
            {user.email} an.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One's own password — **with the old one asked for**.
 *
 * The query is not a courtesy: without it an unattended
 * computer with an open session would be an account that the next person
 * takes over for good. It stands on the server (`ProfileService`); this form
 * only mirrors it.
 */
function PasswordCard(): ReactElement {
  const change = useChangeOwnPassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  /** The number from the answer, once the change has gone through. */
  const [revoked, setRevoked] = useState<number | null>(null);

  const issues = fieldIssues(change.error);
  // **The repetition is compared here and not on the server**: it is
  // no field of the contract (`passwordChangeSchema` does not know it), but
  // a typing aid against the typo nobody sees — the characters
  // stand there as dots.
  const mismatch = repeat !== '' && next !== repeat;
  // **The case still unanswered**, and the reason why it is needed: the
  // submission is blocked until both entries are the same — an empty
  // repetition therefore blocks it too, and without this sentence that would
  // again be a mutely disabled button (finding 6).
  const awaitingRepeat = next !== '' && repeat === '';
  const unmet = passwordCriteria(next);
  const ready =
    current !== '' && unmet === null && next !== '' && next === repeat;

  return (
    <section className="settings-card" aria-labelledby="profile-password">
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="profile-password">
            Passwort ändern
          </h2>
          <p className="settings-card__hint">
            Mindestens {USER_PASSWORD_MIN} Zeichen. Der Wechsel beendet{' '}
            <strong>alle</strong> Anmeldungen dieses Kontos — auf anderen
            Geräten und in jeder Organisation, in der du arbeitest. Hier bleibst
            du angemeldet.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <div className="setting__field">
          <label className="setting__label" htmlFor="profile-password-current">
            Aktuelles Passwort
          </label>
          <input
            className="setting__control"
            id="profile-password-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => {
              setCurrent(event.target.value);
              setRevoked(null);
            }}
          />
        </div>

        <div className="setting__field">
          <label className="setting__label" htmlFor="profile-password-new">
            Neues Passwort
          </label>
          <input
            className="setting__control"
            id="profile-password-new"
            type="password"
            autoComplete="new-password"
            value={next}
            /*
              **The button alone says nothing** (finding 6). Before, it was
              mutely disabled as long as the password was too short — the
              view knew the reason and kept it to itself. Now it stands
              at the field as soon as anything at all is typed: an empty
              field is not yet an error, it is a field not yet begun.
            */
            aria-invalid={
              unmet !== null || issues.newPassword !== undefined
                ? true
                : undefined
            }
            aria-describedby={
              unmet === null && issues.newPassword === undefined
                ? undefined
                : 'profile-password-new-issue'
            }
            onChange={(event) => {
              setNext(event.target.value);
              setRevoked(null);
            }}
          />
          {unmet === null && issues.newPassword === undefined ? null : (
            <p className="setting__issue" id="profile-password-new-issue">
              {issues.newPassword ?? unmet}
            </p>
          )}
        </div>

        <div className="setting__field">
          <label className="setting__label" htmlFor="profile-password-repeat">
            Neues Passwort wiederholen
          </label>
          <input
            className="setting__control"
            id="profile-password-repeat"
            type="password"
            autoComplete="new-password"
            value={repeat}
            aria-invalid={mismatch ? true : undefined}
            aria-describedby={
              mismatch || awaitingRepeat
                ? 'profile-password-repeat-issue'
                : undefined
            }
            onChange={(event) => {
              setRepeat(event.target.value);
              setRevoked(null);
            }}
          />
          {mismatch ? (
            <p className="setting__issue" id="profile-password-repeat-issue">
              Die beiden Eingaben stimmen nicht überein.
            </p>
          ) : awaitingRepeat ? (
            // A hint, not an error: nothing is wrong here, something is
            // still missing here. Therefore without `aria-invalid` and in the
            // quieter type of `.setting__hint`.
            <p className="setting__hint" id="profile-password-repeat-issue">
              Bitte wiederhole das neue Passwort.
            </p>
          ) : null}
        </div>

        <div className="settings__actions">
          <button
            type="button"
            className="settings__save"
            disabled={change.isPending || !ready}
            onClick={() => {
              change.mutate(
                { currentPassword: current, newPassword: next },
                {
                  onSuccess: (result) => {
                    setCurrent('');
                    setNext('');
                    setRepeat('');
                    setRevoked(result.revoked);
                  },
                },
              );
            }}
          >
            {change.isPending ? 'Wird geändert…' : 'Passwort ändern'}
          </button>
        </div>

        {change.isError ? (
          <p className="settings__alert" role="alert">
            {passwordErrorMessage(change.error)}
          </p>
        ) : revoked === null ? null : (
          <p className="settings__notice" role="status">
            {/*
              The number **includes one's own login that was just replaced** —
              the server counts ended sessions, not other people's devices. At
              `1` it was only this one here, and the sentence says exactly
              that, instead of suggesting a threat that there was none of.
            */}
            {revoked <= 1
              ? '✓ Dein Passwort wurde geändert. Es war keine weitere Anmeldung offen.'
              : `✓ Dein Passwort wurde geändert; ${String(revoked - 1)} weitere ${revoked === 2 ? 'Anmeldung wurde' : 'Anmeldungen wurden'} beendet.`}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * **Andere Sitzungen beenden** — pulled here from the header navigation
 * (finding 17).
 *
 * One's own session stays, and that is the point: otherwise the page would
 * fall back to the login, and nobody would read the number the answer carries.
 * At `0` the statement is just as important as at `3` — whoever suspects a
 * break-in then knows that there was no second session.
 */
function SessionsCard(): ReactElement {
  const revoke = useRevokeOtherSessions();
  const [revoked, setRevoked] = useState<number | null>(null);

  return (
    <section className="settings-card" aria-labelledby="profile-sessions">
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="profile-sessions">
            Andere Sitzungen
          </h2>
          <p className="settings-card__hint">
            Beendet deine Anmeldung auf allen anderen Geräten und Browsern —
            auch in jeder anderen Organisation, in der du arbeitest. Diese
            Sitzung hier bleibt bestehen.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <div className="settings__actions">
          <button
            type="button"
            className="settings__save"
            disabled={revoke.isPending}
            onClick={() => {
              setRevoked(null);
              revoke.mutate(undefined, {
                onSuccess: (result) => {
                  setRevoked(result.revoked);
                },
              });
            }}
          >
            {revoke.isPending ? 'Wird beendet…' : 'Andere Sitzungen beenden'}
          </button>
        </div>

        {revoke.isError ? (
          <p className="settings__alert" role="alert">
            Das ist fehlgeschlagen. Bitte erneut versuchen.
          </p>
        ) : revoked === null ? null : (
          <p className="settings__notice" role="status">
            {revoked === 0
              ? '✓ Es gab keine weitere Sitzung.'
              : `✓ ${String(revoked)} weitere ${revoked === 1 ? 'Sitzung wurde' : 'Sitzungen wurden'} beendet.`}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * What is still missing from a typed-in password — `null` when nothing is
 * missing.
 *
 * **All the criteria the schema knows, and none more.**
 * `passwordChangeSchema.newPassword` is `min(USER_PASSWORD_MIN)` and
 * `max(USER_PASSWORD_MAX)`; there is no character-class rule, and one
 * invented here would be a requirement the server does not make at all. The
 * upper bound is not a password policy but the payload limit before Argon2id
 * — it stands here nonetheless, because a password 1200 characters long would
 * otherwise end at the mute button, that is, at exactly the fault this
 * function fixes.
 *
 * **An empty field does not complain.** Whoever has entered nothing yet has
 * done nothing wrong yet.
 */
function passwordCriteria(value: string): string | null {
  if (value === '') {
    return null;
  }
  const missing: string[] = [];
  if (value.length < USER_PASSWORD_MIN) {
    missing.push(`mindestens ${String(USER_PASSWORD_MIN)} Zeichen`);
  }
  if (value.length > USER_PASSWORD_MAX) {
    missing.push(`höchstens ${String(USER_PASSWORD_MAX)} Zeichen`);
  }
  return missing.length === 0
    ? null
    : `Das Passwort braucht ${missing.join(' und ')} — bisher ${String(value.length)}.`;
}

/**
 * The message of a failed password change.
 *
 * 401 here is **not** „you are not signed in" — the session stands, otherwise
 * the page would not have loaded at all —, but „the current password is
 * wrong". Hence the branch of its own instead of `actionErrorMessage`: its 401
 * does not exist, and a passed-through „please sign in" would be the most
 * misleading sentence this card could show.
 */
function passwordErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return error.detail ?? 'Das aktuelle Passwort ist falsch.';
  }
  return actionErrorMessage(error, {
    forbidden: 'Das Passwort kann hier nicht geändert werden.',
    invalid: 'Das Passwort kann hier nicht geändert werden.',
    failed: 'Die Änderung ist fehlgeschlagen. Bitte erneut versuchen.',
  });
}

/**
 * The message of a failed address change.
 *
 * The same 401 special handling as above and for the same reason. The 409
 * („already belongs to somebody") and the 422 („SSO account")
 * `actionErrorMessage` leaves to the server — the rule stands there, here
 * there would only be a second choice of words next to it that drifts away
 * from it. The `conflict` sentence is expressly **only** the fallback for a
 * 409 whose body could not be read; as long as the server speaks, its
 * sentence wins.
 */
function emailErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return error.detail ?? 'Das aktuelle Passwort ist falsch.';
  }
  return actionErrorMessage(error, {
    forbidden: 'Die Adresse kann hier nicht geändert werden.',
    conflict: 'Diese E-Mail-Adresse gehört bereits zu einem anderen Konto.',
    invalid: 'Die Adresse kann hier nicht geändert werden.',
    failed: 'Die Änderung ist fehlgeschlagen. Bitte erneut versuchen.',
  });
}
