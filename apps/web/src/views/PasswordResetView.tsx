import type { ReactElement } from 'react';
import { useState } from 'react';
import { USER_PASSWORD_MIN } from '@formsache/shared';

import { ApiError } from '../api/http';
import { useConfirmPasswordReset } from '../api/session';

import './login-view.css';

/**
 * Setting a password — the page behind the reset link **and** the
 * invitation link (ADR-0020, ADR-0024).
 *
 * ## One page, two wordings
 *
 * Both links carry the same authorisation, lie in the same table and
 * are redeemed via the same route; the server explicitly does **not**
 * distinguish them when redeeming. What differs is the sentence:
 * „Neues Passwort vergeben" is simply wrong for someone who has never had
 * one — they then search for the old one and think the link is
 * broken.
 *
 * How the page knows which case is at hand: from the **address**
 * (`/password/` against `/invitation/`), which the dispatch builds from the kind of the
 * row. Not from a request to the server — a route "what kind of token
 * is this?" does not exist, for good reason (below). That someone can rewrite the
 * address by hand changes nothing: they get the same page with
 * different words and the same answer.
 *
 * ## Outside the shell, before the session check
 *
 * Whoever arrives here is precisely *not* getting at their sign-in — that is the
 * whole occasion. The page therefore stands, like the public fill-in address,
 * next to the application and not in it (`App.tsx`).
 *
 * ## Why it does not check the link beforehand
 *
 * There is no route "is this link still valid?", and that is a
 * decision: it would be a testing device for guessed values without the
 * Argon2id brake of redeeming. The page therefore shows the form and
 * reports the refusal on submitting — the sentence of the **server**, because any
 * distinction of its own ("expired" against "already used") would be information
 * that it deliberately does not give.
 *
 * ## Why it does not sign in
 *
 * After redeeming, a notice and a way to the sign-in stand here, no
 * session. Whoever clicked the link has proved their mailbox and nothing
 * else; signing in with the freshly set password is the step that
 * completes the reset — and the only one that the person who did not request
 * the link also notices.
 */
export function PasswordResetView({
  token,
  mode,
}: {
  readonly token: string;
  /** `'reset'` for `/password/`, `'invitation'` for `/invitation/`. */
  readonly mode: PasswordSetMode;
}): ReactElement {
  const words = WORDING[mode];
  const confirm = useConfirmPasswordReset();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [done, setDone] = useState(false);

  const mismatch = repeat !== '' && password !== repeat;
  const ready = password.length >= USER_PASSWORD_MIN && !mismatch;

  const submit = (): void => {
    confirm.mutate(
      { token, password },
      {
        onSuccess: () => {
          setDone(true);
        },
      },
    );
  };

  if (done) {
    return (
      <main className="login">
        <div className="login__card">
          <div className="login__stripe" />
          <div className="login__body">
            <h1 className="login__title">Passwort gesetzt</h1>
            <p className="login__subtitle" role="status">
              {words.done}
            </p>
            {/*
              `login__form` around the single control, exactly as below — see
              there. Without it the link-shaped button sat flush against the
              paragraph above it.
            */}
            <div className="login__form">
              <a className="login__submit" href="/">
                Zur Anmeldung
              </a>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="login">
      <div className="login__card">
        <div className="login__stripe" />
        <div className="login__body">
          <h1 className="login__title">{words.title}</h1>
          <p className="login__subtitle">
            {words.lead} Mindestens {USER_PASSWORD_MIN} Zeichen.
          </p>

          {/*
            **The whole flow lies in `login__form`** (review round 3 no. 4).
            Up to then the two fields and the button stood directly in
            `login__body`, and that carries no spacing of its own: label,
            field, second field and button touched one another, while the
            sign-in one door further looked right. The spacing of this view is
            not a property of this view — it is `login__form`'s `gap`, and the
            way to get it is to stand in it.

            `noValidate` and `onSubmit` like the sign-in: whoever presses Enter
            in a password field expects a submission, and without a `<form>`
            nothing at all happened there.
          */}
          <form
            className="login__form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!confirm.isPending && ready) {
                submit();
              }
            }}
          >
            <div className="login__field">
              <label className="login__label" htmlFor="password-reset-new">
                {words.field}
              </label>
              <input
                className="login__input"
                id="password-reset-new"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>

            <div className="login__field">
              <label className="login__label" htmlFor="password-reset-repeat">
                Passwort wiederholen
              </label>
              <input
                className="login__input"
                id="password-reset-repeat"
                type="password"
                autoComplete="new-password"
                value={repeat}
                aria-invalid={mismatch ? true : undefined}
                onChange={(event) => {
                  setRepeat(event.target.value);
                }}
              />
              {mismatch ? (
                <p className="login__error" role="alert">
                  Die beiden Eingaben stimmen nicht überein.
                </p>
              ) : null}
            </div>

            <button
              type="submit"
              className="login__submit"
              disabled={confirm.isPending || !ready}
            >
              {confirm.isPending ? 'Wird gesetzt…' : 'Passwort setzen'}
            </button>

            {confirm.isError ? (
              <p className="login__error" role="alert">
                {resetErrorMessage(confirm.error)}
              </p>
            ) : null}
          </form>
        </div>
      </div>
    </main>
  );
}

/**
 * The message of a failed redemption — **the sentence of the server**.
 *
 * It reads the same for "do not know it", "expired", "already used" and "the
 * account signs in via SSO", and this view may not take it
 * apart: the indistinguishability is the purpose, not an
 * imprecision that the interface kindly makes up for.
 */
function resetErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail !== undefined) {
    return error.detail;
  }
  return 'Das hat nicht geklappt. Bitte fordere einen neuen Link an.';
}

/** Which of the two links opened this page. */
export type PasswordSetMode = 'reset' | 'invitation';

/**
 * The four sentences that differ between the two cases — as a
 * `Record`, not as a chain of ternaries.
 *
 * A `Record` forces every new case to answer **all** four;
 * a ternary chain would silently leave one sentence on the wording of the other
 * case. The same build that `ACCOUNT_KIND_LABELS` in `TenantMembersTab.tsx`
 * received after a review finding.
 */
const WORDING: Record<
  PasswordSetMode,
  {
    readonly title: string;
    readonly lead: string;
    readonly field: string;
    readonly done: string;
  }
> = {
  reset: {
    title: 'Neues Passwort vergeben',
    lead: 'Sobald du speicherst, werden alle offenen Anmeldungen dieses Kontos beendet.',
    field: 'Neues Passwort',
    done: 'Dein neues Passwort gilt ab sofort. Alle offenen Anmeldungen dieses Kontos wurden dabei beendet — auch auf anderen Geräten.',
  },
  invitation: {
    title: 'Willkommen bei Formsache',
    lead: 'Für dich wurde ein Konto angelegt. Vergib jetzt dein Passwort — danach meldest du dich mit deiner E-Mail-Adresse und diesem Passwort an.',
    field: 'Dein Passwort',
    done: 'Dein Passwort ist gesetzt. Melde dich jetzt mit deiner E-Mail-Adresse und diesem Passwort an.',
  },
};
