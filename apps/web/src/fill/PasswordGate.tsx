import type { ReactElement, SyntheticEvent } from 'react';
import { useId, useState } from 'react';
import type { LockedPublicForm } from '@formsache/shared';

import { useUnlockForm } from '../api/public-form';
import { ApiError } from '../api/http';

/**
 * The password gate a participant meets in front of a protected form.
 *
 * **Invented, and said so.** The design handoff has no participant-facing gate:
 * it only shows the *editor's* switch („Passwortschutz") and a field where the
 * word is set, and the prototype never renders the fill-in side of it. So this
 * is built from the pieces the handoff does define — the same `public__card` a
 * form and its confirmation page use, the same tenant header above it, the same
 * primary button — and adds nothing of its own beyond one label, one input and
 * one sentence.
 *
 * **It is a comfort, not the protection.** The questions are not on this page in
 * a hidden `<div>`; the server did not send them (`public-forms.service.ts`).
 * Deleting this component would leave a participant unable to fill in the form,
 * not able to read it — which is the difference between a gate and a curtain.
 */
export function PasswordGate({
  slug,
  form,
  onUnlocked,
}: {
  readonly slug: string;
  readonly form: LockedPublicForm;
  readonly onUnlocked: (proof: string) => void;
}): ReactElement {
  const [word, setWord] = useState('');
  const unlock = useUnlockForm(slug);
  const fieldId = useId();

  function onSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    // A real `<form>`, so „Enter" in the field submits — the gesture everybody
    // makes at a password field. `preventDefault` because the request goes
    // through `fetch`; a native submit would put the word in a URL, which is
    // the one thing bullet 6 of the requirement forbids.
    event.preventDefault();
    if (word.length === 0) {
      return;
    }
    unlock.mutate(word, {
      onSuccess: (proof) => {
        onUnlocked(proof);
      },
    });
  }

  /*
   * **The server does not say why**, and this sentence is the client guessing
   * from context — deliberately, and it is the right place for the guess.
   *
   * A wrong word and an address that leads nowhere are answered byte for byte
   * alike (second bullet), so the 404 here carries „Dieses
   * Formular gibt es nicht." Showing that would be worse than useless to
   * somebody who just mistyped: the browser already knows the form is real,
   * because it received the locked payload a moment ago. So the client says the
   * useful thing while the server keeps saying nothing.
   */
  const refused =
    unlock.error instanceof ApiError && unlock.error.status === 404;
  const throttled =
    unlock.error instanceof ApiError && unlock.error.status === 429;

  /**
   * The message is **tied to the field**, not merely placed under it.
   *
   * `role="alert"` announces the sentence once, when it appears. It does not
   * make the field itself carry the fault: a screen-reader user who tabs back
   * into the input afterwards — the very next thing anybody does — hears the
   * label and nothing else, and the input reads as valid. `FieldInput.tsx` next
   * door already does it properly with the same two attributes; this is that
   * pattern, not a new one.
   */
  const errorId = `${fieldId}-error`;
  const failed = unlock.isError;

  return (
    <section className="public__card public__card--gate">
      <h1 className="public__title">{form.title}</h1>
      <p className="public__message">
        Dieses Formular ist passwortgeschützt. Bitte das Zugangswort eingeben,
        das mit der Einladung verschickt wurde.
      </p>

      <form className="public__gate-form" onSubmit={onSubmit} noValidate>
        <label className="public__gate-label" htmlFor={fieldId}>
          Zugangswort
        </label>
        <input
          id={fieldId}
          // `field__control` is the shared box of every input in this file; the
          // gate's own class now carries nothing but the narrower `max-width`.
          className="field__control public__gate-input"
          aria-invalid={failed}
          {...(failed ? { 'aria-describedby': errorId } : {})}
          // `type="password"`, so it is not readable over a shoulder and no
          // browser offers it back as a form suggestion on the next form.
          type="password"
          // `current-password` rather than `off`: this *is* an existing shared
          // word, and a password manager that keeps it per site is the
          // behaviour a participant expects. `off` is widely ignored anyway.
          autoComplete="current-password"
          autoFocus
          value={word}
          onChange={(event) => {
            setWord(event.target.value);
          }}
        />

        {failed ? (
          <p className="public__error" role="alert" id={errorId}>
            {refused
              ? 'Das Zugangswort stimmt nicht. Bitte erneut versuchen.'
              : throttled
                ? 'Zu viele Versuche von dieser Verbindung. Bitte in einer Minute erneut versuchen.'
                : 'Das Zugangswort konnte nicht geprüft werden. Bitte erneut versuchen.'}
          </p>
        ) : null}

        <div className="public__actions">
          <button
            type="submit"
            className="public__primary"
            disabled={unlock.isPending || word.length === 0}
          >
            {unlock.isPending ? 'Wird geprüft…' : 'Weiter'}
          </button>
        </div>
      </form>
    </section>
  );
}
