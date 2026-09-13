import type { ReactElement } from 'react';
import type { ResponseEdit } from '@formsache/shared';
import { formatDeadline } from '@formsache/shared';

import { ApiError } from '../api/http';
import { useResponseEdit, useUpdateResponse } from '../api/public-form';
import { FillIn } from '../fill/FillIn';
import { storedAnswers } from '../fill/stored-answers';
import { TenantHeader } from '../fill/TenantHeader';
import { PublicLegalFooter } from '../fill/PublicLegalFooter';
import { tenantThemeStyle } from '../styles/tenant-theme';

import './public-form-view.css';

/**
 * „Bearbeiten nach Absenden" — the participant's own answer, open again.
 *
 * Outside the shell and before the session check, exactly like the fill-in
 * view: whoever follows this link has no account. The token in the address is
 * the whole capability, so this view asks the server one question and renders
 * whatever comes back.
 *
 * **It is the fill-in view with the answers filled in**, and literally so — the
 * questions, the paging, the validation and the receipt all come from
 * `fill/FillIn.tsx`. What is added here is the frame around it: the notice that
 * says this is a correction rather than a new registration, and the refusals
 * that are the *whole page* here instead of a banner under a form.
 */
export function ResponseEditView({
  token,
}: {
  readonly token: string;
}): ReactElement {
  const query = useResponseEdit(token);

  if (query.isPending) {
    return (
      <main className="public" role="status">
        <p className="public__state">Antwort wird geladen…</p>
      </main>
    );
  }

  // `query.data === undefined`, not `query.isError`. A *background* refetch
  // that fails — `refetchOnReconnect` after a lost connection, a remount, an
  // invalidation — leaves the last good data in the cache and only sets the
  // error flag. Swapping the whole page for the refusal at that point would
  // throw away everything the participant has typed and not yet saved, on a
  // page whose entire purpose is typing (`FillIn` seeds its state from
  // `initialAnswers` **once**, so the loss is not recoverable by re-rendering).
  // An error with data behind it is a stale page; an error without it is the
  // refusal this view exists to show.
  //
  // `refetchOnWindowFocus` is off for this client, which narrows how often this
  // happens but decides nothing: the reachable triggers above are enough, and
  // „hängt daran, dass eine Option in `query-client.ts` aus bleibt" is not a
  // property to build a data-loss guarantee on.
  if (query.data === undefined) {
    return <NotEditable error={query.error} />;
  }

  return <Editing token={token} data={query.data} />;
}

/**
 * Why this answer cannot be opened — **and the sentence comes from the server**.
 *
 * The three states behind a 409 are three different pieces of advice
 * („geschlossen", „Bearbeiten ausgeschaltet", „noch nicht geöffnet"), and the
 * server has already written each of them once
 * (`SUBMISSION_REFUSAL_MESSAGES`). Composing a second set here would be a
 * second answer to the same question, and the two would drift — which is the
 * duplication this project has paid for before.
 *
 * A 404 is the other case and is deliberately vague: an unknown token, an
 * answer in the trash and a withdrawn form are one answer on the server
 * (byte-identical), and saying more here would undo that.
 */
function NotEditable({ error }: { readonly error: unknown }): ReactElement {
  const refusal =
    error instanceof ApiError && error.status === 409
      ? error.refusal
      : undefined;

  const message =
    refusal?.message ??
    (error instanceof ApiError && error.status === 404
      ? 'Diese Adresse führt zu keiner Antwort. Vielleicht ist der Link nicht vollständig, oder die Antwort wurde gelöscht.'
      : 'Die Antwort konnte nicht geladen werden. Bitte später erneut versuchen.');

  return (
    <main className="public" data-testid="response-edit-unavailable">
      <section className="public__card">
        <h1 className="public__title">Antwort bearbeiten</h1>
        <p className="public__state" role="status">
          {message}
        </p>
      </section>
    </main>
  );
}

function Editing({
  token,
  data,
}: {
  readonly token: string;
  readonly data: ResponseEdit;
}): ReactElement {
  const { form } = data;
  // The start token this page was loaded with. An edit is an
  // „Ausfüllung" as far as the time limit is concerned, and reloading starts a
  // fresh attempt — the same reach and the same gap as a first fill-in.
  const submit = useUpdateResponse(token, form.startToken);

  return (
    <main
      className="public"
      data-tenant-theme=""
      style={tenantThemeStyle(form.tenant.branding)}
      data-testid="response-edit"
    >
      <TenantHeader tenant={form.tenant} />
      {/*
        `key={token}` — the fill-in state belongs to **one** answer.

        `FillIn` reads `initialAnswers` once (see there) so that a refetch cannot
        overwrite what is being typed; a second Bearbeiten-Link opened in the
        same tab must therefore remount it, or the previous answer's values —
        and `EventField`'s note of which boxes already held a Personenzahl —
        would be shown as this one's.
      */}
      <FillIn
        key={token}
        form={form}
        submit={submit}
        // The stored answers, as they were given — validated against this very
        // version on the way in and handed back untouched. Checked
        // here, not asserted: see {@link storedAnswers}.
        initialAnswers={storedAnswers(form.definition, data.answers)}
        submitLabel="Änderungen speichern"
        pendingLabel="Wird gespeichert…"
        intro={<EditNote data={data} />}
        // The upload door of *this* path: the token, whose
        // route runs the edit refusal chain — no password gate, because the mail
        // that carries this link carries no access word (`byEditToken`).
        uploadTarget={{ kind: 'edit', token }}
      />
      {/*
        The footer — here as well. Whoever follows this link is the same person
        who filled the form in, and needs the same way to the privacy notice
        (`docs/legal/README.md` 5.3: „unter **jeder** öffentlichen Ansicht").
      */}
      <PublicLegalFooter
        organisation={{
          shortName: form.tenant.shortName,
          name: form.tenant.name,
        }}
        privacyNotice={form.privacyNotice}
      />
    </main>
  );
}

/**
 * The one sentence that tells a participant where they are.
 *
 * Without it this page is indistinguishable from a fresh registration form with
 * somebody else's data in it — which is precisely the wrong impression on a
 * screen that can overwrite an existing answer.
 *
 * The two instants are shown side by side because they are **kept** side by
 * side: `submittedAt` is when the registration arrived and never
 * moves, `editedAt` is when it was last corrected. Formatted through
 * `formatDeadline` so the zone is named, for the same reason the deadline
 * enforcement exists: a time whose zone one has to guess becomes contentious
 * between two Organisationen.
 */
function EditNote({ data }: { readonly data: ResponseEdit }): ReactElement {
  return (
    <p className="public__edit-note" data-testid="response-edit-note">
      Dies ist eine bereits abgesendete Antwort. Abgesendet am{' '}
      {formatDeadline(data.submittedAt)}
      {data.editedAt === null
        ? ''
        : `, zuletzt geändert am ${formatDeadline(data.editedAt)}`}
      . Änderungen ersetzen die bisherige Antwort — es entsteht keine zweite.
    </p>
  );
}
