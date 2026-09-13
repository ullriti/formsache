import { useState, type ReactElement } from 'react';
import { USER_PASSWORD_MIN, setupRequestSchema } from '@formsache/shared';

import { login } from '../../api/auth';
import { ApiError } from '../../api/http';
import { runSetup } from '../../api/setup';
import { TextSetting } from '../settings/SettingsControls';
import { WizardFrame, type WizardStepMeta } from '../../wizard';

/**
 * **Step 1 — the first access** (ADR-0022).
 *
 * It is the only step before a session and therefore the only one that does
 * not talk to the ordinary settings routes: what it calls is
 * `POST /api/setup`, the one unprotected route of this application, which
 * creates a superadministrator as long as the installation has **zero rows in
 * `user`**.
 *
 * ## The session comes about through an ordinary sign-in, not through the
 * setup route
 *
 * After this step the wizard needs a session — steps 2 to 8 are signed-in
 * system settings routes. `POST /api/setup` nevertheless **still issues none**
 * (ADR-0022 no. 2, 204 without a body): the most dangerous route of the
 * application gets not one line of power added to it.
 *
 * Instead this step signs in immediately afterwards through
 * `POST /api/auth/login` — with exactly the credentials that were typed one
 * line further up and that are in this form's memory anyway. That is the same
 * path a human would have taken by hand a second later, through the same
 * guard, the same rate limit and the same password check. And it keeps the
 * promise of ADR-0022 instead of replacing it: *that the credentials just set
 * work is thereby proven* — if the sign-in fails, this step says so and sends
 * to the sign-in mask.
 *
 * ⚠️ **Deliberately `login()` and not `useLogin()`.** The hook writes the
 * session into the query cache and discards it; `App.tsx` thereupon swapped
 * the setup for the signed-in shell in the middle of the flow and would tear
 * the wizard away. The cache therefore stays as it is — the cookie is set, the
 * following steps carry it, and the application learns of the change of
 * session at the end through a full reload.
 *
 * ## The organisation is no longer here
 *
 * `POST /api/setup` still takes a `tenant`; this step **always** sends
 * **`null`**. The first organisation has become step 8 and uses
 * „+ Neue Organisation" there — the same mask, the same route, the same rules
 * as every later one. Two ways of creating an organisation would be two places
 * at which the groups, the defaults and the first administrator could differ.
 */

/** What a failure of the setup may say. */
const UNAVAILABLE_MESSAGE =
  'Die Einrichtung ist zurzeit nicht möglich. Bitte versuche es später erneut.';

/**
 * The 404 — "this installation is already set up".
 *
 * The server answers 404 as if the route did not exist, and for a stranger
 * that is the whole information. Whoever has this mask in front of them,
 * though, got it because the same installation said "not set up" a moment ago
 * — so the only explanation is that somebody else has finished in the
 * meantime.
 */
const ALREADY_MESSAGE =
  'Diese Installation ist inzwischen eingerichtet. Bitte lade die Seite neu und melde dich an.';

/**
 * The access stands, the sign-in does not — the one case in which this step
 * has succeeded and the wizard nevertheless cannot go on.
 */
const LOGIN_FAILED_MESSAGE =
  'Der Zugang ist angelegt, die automatische Anmeldung hat aber nicht geklappt. Bitte lade die Seite neu und melde dich mit den eben gesetzten Daten an — der Rest der Einrichtung steht danach in der Systemverwaltung. Ein zweiter Versuch hier hilft nicht: das Konto gibt es schon.';

/**
 * What stands **at the one field** that did not get through.
 *
 * One sentence per field is no convenience but the difference between
 * "something is not right" and "this here is not right" — with an address that
 * has a typo in it one otherwise searches for a long time, because the field
 * *is* filled in.
 */
const FIELD_MESSAGES = {
  name: 'Bitte gib deinen Namen an.',
  email: 'Bitte gib eine gültige E-Mail-Adresse an.',
  password: `Bitte wähle ein Passwort mit mindestens ${String(USER_PASSWORD_MIN)} Zeichen.`,
} as const;

const REPEAT_MISSING_MESSAGE = 'Bitte wiederhole das Passwort.';
const REPEAT_MISMATCH_MESSAGE = 'Die beiden Eingaben stimmen nicht überein.';

type AdminField = keyof typeof FIELD_MESSAGES;
type FieldErrors = Partial<Record<AdminField | 'repeat', string>>;

function isAdminField(value: unknown): value is AdminField {
  return value === 'name' || value === 'email' || value === 'password';
}

export interface AccessStepProps {
  readonly steps: readonly WizardStepMeta[];
  readonly index: number;
  /** The access stands **and** so does the session — on to step 2. */
  readonly onDone: () => void;
}

export function AccessStep({
  steps,
  index,
  onDone,
}: AccessStepProps): ReactElement {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The repetition, compared live — the same mechanics as in the profile and
   * for the same reason: the characters stand there as dots, a typo is
   * invisible, and here the **only** account of the installation comes into
   * being. Whoever creates it with a mistyped password does not get in at all
   * any more — there is nobody who would let them back in, and „Passwort
   * vergessen" needs a mail dispatch that a fresh installation does not have
   * yet.
   *
   * **The comparison stays in the browser.** `setupRequestSchema` knows no
   * field for it, and it is not to get one either: the repetition is a writing
   * aid, not a datum.
   */
  const mismatch = repeat !== '' && password !== repeat;
  const awaitingRepeat = password !== '' && repeat === '';
  const repeatIssue = mismatch
    ? REPEAT_MISMATCH_MESSAGE
    : (fieldErrors.repeat ??
      (awaitingRepeat ? REPEAT_MISSING_MESSAGE : undefined));

  const clearField = (field: AdminField | 'repeat'): void => {
    setFieldErrors((previous) =>
      previous[field] === undefined
        ? previous
        : Object.fromEntries(
            Object.entries(previous).filter(([key]) => key !== field),
          ),
    );
  };

  const submit = (): void => {
    if (busy) {
      return;
    }

    // Checked **with the same schema as on the server**. That saves a round
    // trip and normalises the address in just the same way; a security measure
    // it is not — the server checks for itself in every case.
    const parsed = setupRequestSchema.safeParse({
      admin: { email, name, password },
      // Always `null`: the organisation is step 8 (see above).
      tenant: null,
    });

    const fields: FieldErrors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [scope, field] = issue.path;
        if (scope === 'admin' && isAdminField(field)) {
          fields[field] ??= FIELD_MESSAGES[field];
        }
      }
    }
    // The floor under the locked button: a form can be submitted with the
    // enter key from inside a text field as well.
    if (password !== repeat) {
      fields.repeat =
        repeat === '' ? REPEAT_MISSING_MESSAGE : REPEAT_MISMATCH_MESSAGE;
    }

    setFieldErrors(fields);
    if (Object.keys(fields).length > 0 || !parsed.success) {
      // And the refusal of an *earlier* attempt goes: otherwise a sentence
      // about a request that did not happen this time would still stand above
      // the fresh field messages.
      setMessage(null);
      return;
    }

    setMessage(null);
    setBusy(true);
    /**
     * **Two calls, and the sentence afterwards has to know which one has
     * failed.**
     *
     * Without this mark "the account could not be created" would look just
     * like "the account stands, the sign-in went wrong" — and the difference
     * is the most expensive one of this mask: in the first case one should try
     * again, in the second exactly that would be the way into a 404. Only
     * `login()` can throw a 401, but a torn-off network throws **no**
     * `ApiError`, and then the status check would otherwise decide about a
     * state it does not see.
     */
    let created = false;
    void runSetup(parsed.data)
      .then(async () => {
        created = true;
        // The sign-in is part of this step — see the head of the file.
        await login({ email: parsed.data.admin.email, password });
        onDone();
      })
      .catch((error: unknown) => {
        setBusy(false);
        if (error instanceof ApiError && error.status === 404) {
          setMessage(ALREADY_MESSAGE);
          return;
        }
        setMessage(created ? LOGIN_FAILED_MESSAGE : UNAVAILABLE_MESSAGE);
      });
  };

  return (
    <WizardFrame
      title="Erste Einrichtung"
      intro="Diese Installation hat noch kein Konto. Der Assistent führt einmal durch alles, was eine Installation braucht — jeder Schritt außer diesem lässt sich überspringen und später nachholen."
      steps={steps}
      currentIndex={index}
      primary={{
        label: busy ? 'Einrichtung läuft…' : 'Zugang anlegen und weiter',
        onClick: submit,
        // Locked as long as the two password entries are not equal. The
        // reason stands at the field above, so that the lock is explained and
        // does not merely take effect.
        disabled: busy || password !== repeat,
      }}
      error={message}
    >
      <section className="settings-card" aria-labelledby="setup-access-heading">
        <header className="settings-card__head">
          <div className="settings-card__text">
            <h3 className="settings-card__heading" id="setup-access-heading">
              Superadministrator
            </h3>
            <p className="settings-card__hint">
              Dieses Konto darf die ganze Installation verwalten. Es gehört
              keiner Organisation an — das ist ein gültiger Endzustand und
              bleibt es, wenn du den letzten Schritt überspringst und keine
              Organisation anlegst.
            </p>
          </div>
        </header>

        <div className="settings-card__body">
          <TextSetting
            label="Name"
            value={name}
            autoComplete="name"
            issue={fieldErrors.name}
            onChange={(next) => {
              setName(next);
              clearField('name');
            }}
          />
          <TextSetting
            label="E-Mail-Adresse"
            value={email}
            type="email"
            autoComplete="email"
            issue={fieldErrors.email}
            onChange={(next) => {
              setEmail(next);
              clearField('email');
            }}
          />
          <TextSetting
            label="Passwort"
            value={password}
            type="password"
            // `new-password`, not `current-password`: here one is being set,
            // and the browser's password manager should suggest one instead of
            // offering one that does not exist.
            autoComplete="new-password"
            note={`Mindestens ${String(USER_PASSWORD_MIN)} Zeichen.`}
            issue={fieldErrors.password}
            onChange={(next) => {
              setPassword(next);
              clearField('password');
              clearField('repeat');
            }}
          />
          <TextSetting
            label="Passwort wiederholen"
            value={repeat}
            type="password"
            autoComplete="new-password"
            issue={repeatIssue}
            onChange={(next) => {
              setRepeat(next);
              clearField('repeat');
            }}
          />
        </div>
      </section>
    </WizardFrame>
  );
}
