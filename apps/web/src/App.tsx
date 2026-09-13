import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { useSession } from './api/session';
import { useSetupState } from './api/setup';
import { useRoute } from './router/use-route';
import { AppShell } from './shell/AppShell';
import { LoginView } from './views/LoginView';
import { SetupView } from './views/SetupView';
import { PasswordResetView } from './views/PasswordResetView';
import { PublicFormView } from './views/PublicFormView';
import { LicencesView } from './views/legal/LicencesView';
import {
  SystemLegalPageView,
  TenantLegalPageView,
} from './views/legal/LegalPageView';
import { ResponseDraftView } from './views/ResponseDraftView';
import { ResponseEditView } from './views/ResponseEditView';

import './app.css';

/**
 * Decides what the user sees, and it decides it from **one** source: the
 * result of `GET /api/auth/me`.
 *
 * There is no local "logged in" flag. The session cookie is httpOnly, so the
 * app cannot inspect it, and any flag it kept instead could disagree with the
 * server — always in the direction of showing a shell to someone the server
 * has already signed out.
 *
 * A failed session check (not a 401 — a 500, a broken proxy, a response that
 * does not match the shared schema) leads to the login view with a notice, not
 * to a half-rendered shell: if the payload cannot be trusted, there is nothing
 * to render an admin surface from.
 *
 * **One exception, and it points in the other direction:** a running
 * setup run holds the assistant in place, even when `/auth/me`
 * meanwhile carries a user (see `setupRunning` below). That is no
 * second "signed in" flag — it decides nothing about a session,
 * but records a piece of information from the server that already existed:
 * that this installation had not a single account when this page was entered.
 */
export function App(): ReactElement {
  const route = useRoute();
  const session = useSession();

  /**
   * **Whether a setup run is currently going on** — decided once, kept for the
   * duration of the run.
   *
   * ## What happened without this lock, measured on 2026-08-18
   *
   * The assistant announced eight steps and was no longer
   * reachable from step 3 on: after „Überspringen" on step 2 the system
   * administration stood there. The obvious suspicion — that `GET /api/setup`
   * now answers `setupRequired: false` and takes the ground from under the
   * view — is **wrong** and measured: this route is asked exactly **once** per
   * page load (`staleTime: Infinity`, no `invalidate`, see `api/setup.ts`).
   *
   * What tore the assistant away was the **session question**. Step 1 signs
   * in immediately after `POST /api/setup` (ADR-0022, continuation
   * no. 2), and from then on the 401 from `/auth/me` is outdated. It is enough
   * that anyone asks the question once more — and in step 3 that is done by
   * `MailServerStep` with its own `useSession()`: a second observer
   * of the same query, whose answer without `staleTime` is stale at once, so
   * a `refetchOnMount`. The answer now carries a user, and the line
   * `session.data === null` further below switched over to `AppShell`. Step 8
   * would have done the same, there even expressly: `useCreateTenant`
   * invalidates the session query so that the fresh membership arrives.
   *
   * ## Why a lock and not a second prohibition
   *
   * "No step may ask the session" would be a rule that nobody can
   * keep to: the steps deliberately show the same cards as the
   * system administration, and those ask. The decision is therefore made
   * **once on entering** — and the decision is no claim of the browser,
   * but the answer of the server that already existed for it: `SignedOut`
   * switches this lock on exactly when `GET /api/setup` has said
   * `setupRequired: true`, that is when the installation had not a single
   * account at that moment.
   *
   * ⚠️ **The promise from ADR-0022 no. 1 thereby stands word for word:** an
   * already set-up installation shows the sign-in without a session. The
   * server says `setupRequired: false` there, the lock never goes on, and
   * `POST /api/setup` is untouched by it anyway — the condition "zero rows
   * in `user`" sits in the same transaction as the write (§3).
   *
   * It ends with the run: `SetupComplete` reloads the page completely
   * (and a reload in the middle lands in the signed-in application, because the
   * session stands — nobody is locked in here).
   */
  const [setupRunning, setSetupRunning] = useState(false);
  const beginSetupRun = useCallback(() => {
    setSetupRunning(true);
  }, []);

  /**
   * The public fill-in address short-circuits everything above.
   *
   * Before the session check, and outside the shell: participants have no
   * account, so waiting for `GET /api/auth/me` would make them watch a
   * spinner for a question that does not concern them — and answering with the
   * login view would be the precise opposite of "ohne Login ausfüllen".
   *
   * `useSession` still runs (hooks cannot be skipped), and that is harmless:
   * the query answers 401, nothing renders from it, and the fill-in view never
   * consults it.
   */
  if (route.kind === 'public-form') {
    return <PublicFormView slug={route.slug} />;
  }

  /**
   * „Bearbeiten nach Absenden" short-circuits for exactly the same reasons
   * : whoever follows this link is a participant, has no
   * account, and must not be asked to log in to correct their own answer.
   */
  if (route.kind === 'response-edit') {
    return <ResponseEditView token={route.token} />;
  }

  /**
   * *Zwischenspeichern* resumed — the same short-circuit as
   * the two above, and for the same reason: the person following `/e/<token>`
   * has no account.
   */
  if (route.kind === 'response-draft') {
    return <ResponseDraftView token={route.token} />;
  }

  /**
   * **The legal text pages** (ADR-0028) — the same short-circuit as the three
   * above, and with the strongest reason of all: § 18 Abs. 1 MStV demands
   * „ständig verfügbar", Art. 13 Abs. 1 DSGVO „zum Zeitpunkt der Erhebung".
   * A sign-in mask in front of an Impressum would be no Impressum.
   *
   * They stand **before** the session check and thereby also before the
   * question of the first setup — an installation that has no account yet must
   * be able to deliver its Impressum nonetheless, otherwise the one state in
   * which certainly nothing is stored would also be the one in which nobody
   * learns of it.
   */
  if (route.kind === 'system-legal') {
    return <SystemLegalPageView page={route.page} />;
  }

  if (route.kind === 'tenant-legal') {
    return (
      <TenantLegalPageView shortName={route.shortName} page={route.page} />
    );
  }

  if (route.kind === 'licences') {
    return <LicencesView />;
  }

  /**
   * The reset link (ADR-0020) — the same short-circuit as the three above,
   * and with the sharpest reason of all: whoever arrives here is precisely
   * **not** getting at their sign-in. To put the page behind the sign-in
   * would be the door that one locks in front of the key.
   */
  if (route.kind === 'password-reset') {
    return <PasswordResetView token={route.token} mode="reset" />;
  }

  /**
   * The invitation link (ADR-0024) — the same page, a different wording, and
   * the same short-circuit: whoever arrives here has no account at all yet
   * that they could sign in to.
   */
  if (route.kind === 'account-invitation') {
    return <PasswordResetView token={route.token} mode="invitation" />;
  }

  if (session.isPending && !setupRunning) {
    return (
      <div className="app-loading" role="status">
        Anmeldestatus wird geprüft…
      </div>
    );
  }

  /**
   * **The running assistant takes precedence over the session** — and only it.
   *
   * Without the first condition the first setup ended in step 3: the
   * assistant signs in after step 1 (ADR-0022, continuation no. 2),
   * and the next answer from `GET /api/auth/me` would suddenly carry a
   * user here — the line below it swapped the assistant in the middle of the
   * flow for the signed-in shell.
   */
  if (setupRunning || session.data === null || session.data === undefined) {
    return (
      <SignedOut
        sessionCheckFailed={session.isError}
        onSetupRunning={beginSetupRun}
      />
    );
  }

  return <AppShell user={session.data} />;
}

/**
 * What somebody without a session sees — the sign-in **or** the first setup
 * (ADR-0022, the third state *before* the sign-in).
 *
 * Here and not in the route table, and that is the decision: the
 * setup is no address in the signed-in area, but a state
 * before it — at the same place at which the decision between "session there"
 * and "sign-in page" has been made all along, and from the same one source:
 * the server.
 *
 * ## Why this is a component of its own
 *
 * Because `useSetupState` would otherwise stand at the wrong place, and that
 * was no cosmetic flaw: hooks run **before** every `return`, so also before
 * the four short-circuits in {@link App}. A `useSetupState` up there therefore
 * asked `GET /api/setup` also on `/f/<slug>` — on the fill-in path whose
 * whole point is that a participant touches no session machinery.
 * She collects a 401 on `/auth/me` there anyway (hooks cannot be
 * skipped), and out of this 401 there then became a **second** request per
 * page load, which enters itself into the counter of `SETUP_STATE_RATE_LIMIT` —
 * 120 per minute and address, shared by a whole branch office behind
 * one address, in exactly the hour in which a registration is open (a
 * review finding).
 *
 * A condition in `enabled` would have achieved the same and would have been a
 * **second list of the public routes**, next to the four `if` blocks above
 * — so the sort of duplication in which the fifth public route quietly lands
 * in only one of the two. As a component of its own the question can no longer
 * be asked at the wrong place at all: this tree is mounted only when
 * the application really stands before the sign-in.
 *
 * ## And why the sign-in waits for the answer
 *
 * A sign-in mask that is replaced a second later by a setup mask
 * would be the more restless variant — and it would occur of all times at
 * the one occasion at which somebody sits in front of this application for
 * the first time. That is paid for with a second round after the session
 * check; what it costs is one index access to an answer that changes exactly
 * once in the life of an installation.
 */
function SignedOut({
  sessionCheckFailed,
  onSetupRunning,
}: {
  readonly sessionCheckFailed: boolean;
  /**
   * Reports to the host that a setup run has begun — **once**,
   * and only out of an answer of the server.
   *
   * Why the report has to go upwards and the decision cannot stay
   * here: as soon as step 1 has signed in, this component would not get its
   * turn at all any more — {@link App} would decide one line earlier for
   * the signed-in shell. The lock therefore belongs where it takes effect.
   */
  readonly onSetupRunning: () => void;
}): ReactElement {
  /**
   * On a *failed* session check the question is not even asked:
   * out of "we do not know" no setup mask may be made. That is the
   * one direction in which an error would be expensive here — and the same
   * direction is taken by a failure of the setup question itself, because
   * `data` then stays `undefined` and below stands the sign-in.
   */
  const setup = useSetupState({ enabled: !sessionCheckFailed });
  const setupRequired = setup.data?.setupRequired === true;

  /**
   * In the effect and not in the body: a `setState` of the host during the
   * rendering of a child is exactly the case that React shouts about — and it
   * would be wrong here on the merits too, because the report is an event
   * ("the run has begun") and not a derivation.
   */
  useEffect(() => {
    if (setupRequired) {
      onSetupRunning();
    }
  }, [setupRequired, onSetupRunning]);

  if (!sessionCheckFailed && setup.isPending) {
    return (
      <div className="app-loading" role="status">
        Einrichtungsstatus wird geprüft…
      </div>
    );
  }

  if (setupRequired) {
    return <SetupView />;
  }

  return <LoginView sessionCheckFailed={sessionCheckFailed} />;
}
