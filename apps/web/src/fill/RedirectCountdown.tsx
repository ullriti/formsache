import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { RedirectTarget } from '@formsache/shared';

import { leaveTo } from './leave-to';

/** „Weiterleitung in 5 Sekunden …" — the handoff's sentence (*Vorschau*). */
export function redirectNotice(remaining: number): string {
  return `Weiterleitung in ${String(remaining)} ${
    remaining === 1 ? 'Sekunde' : 'Sekunden'
  } …`;
}

/**
 * What stands there once the counting is over.
 *
 * The notice used to disappear at zero — exactly when the navigation starts.
 * A slow target then left the participant in front of a page with the receipt
 * on it and no sign that anything was happening, which reads as „nichts
 * passiert" and invites a reload of a form that has already been submitted.
 */
export const REDIRECT_RUNNING_TEXT = 'Weiterleitung läuft …';

/**
 * The countdown on the confirmation page, and the redirect it ends in.
 *
 * **The wait is not decoration.** The answer has just been stored, and the
 * confirmation is the only acknowledgement a participant ever gets — leaving
 * immediately would take the receipt off the screen before it was read. The
 * editor sets the seconds; `redirectDelay` allows `0`, and then this component
 * leaves on its first effect without ever showing a countdown of „0" — the
 * notice reads {@link REDIRECT_RUNNING_TEXT} straight away.
 *
 * The target is **not** re-checked here. It arrived through
 * `submitResponseResponseSchema`, which puts it through the same
 * `http`/`https` schema the server writes it with, and a fourth opinion at the
 * last call site would be one nobody could test on its own.
 */
export function RedirectCountdown({
  redirect,
}: {
  readonly redirect: RedirectTarget;
}): ReactElement {
  const [remaining, setRemaining] = useState(redirect.delaySec);
  /**
   * Leaving happens **once**, whatever the effect does.
   *
   * A ref rather than state, because it must not cause a render and must
   * survive one: under `StrictMode` React runs the effect, tears it down and
   * runs it again, so `delaySec: 0` produced two `location.assign` calls in
   * development. The browser survives that; the second call is a navigation
   * begun while the first is in flight, and the failure it hides — an effect
   * that fires more often than the countdown reaches zero — is the kind nobody
   * sees until a target is slow.
   */
  const left = useRef(false);

  useEffect(() => {
    if (remaining > 0) {
      const timer = setTimeout(() => {
        setRemaining((seconds) => seconds - 1);
      }, 1_000);
      return () => {
        clearTimeout(timer);
      };
    }
    if (!left.current) {
      left.current = true;
      leaveTo(redirect.url);
    }
    return undefined;
  }, [remaining, redirect.url]);

  return (
    <p className="public__redirect">
      {remaining > 0 ? redirectNotice(remaining) : REDIRECT_RUNNING_TEXT}
    </p>
  );
}
