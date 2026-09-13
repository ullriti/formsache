import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import type { ResponseDraft } from '@formsache/shared';
import { formatDeadline } from '@formsache/shared';

import { ApiError } from '../api/http';
import {
  useDeleteDraft,
  useResponseDraft,
  useSubmitResponse,
  useUpdateDraft,
} from '../api/public-form';
import { FillIn } from '../fill/FillIn';
import { storedAnswers } from '../fill/stored-answers';
import { TenantHeader } from '../fill/TenantHeader';
import { PublicLegalFooter } from '../fill/PublicLegalFooter';
import { tenantThemeStyle } from '../styles/tenant-theme';
import { ConfirmPrompt } from './tenant-admin/ConfirmPrompt';

import './public-form-view.css';

/**
 * *Zwischenspeichern* resumed — `/e/<token>`.
 *
 * Outside the shell and before the session check, exactly like the fill-in
 * and the edit view: whoever follows this link has no account. The token in
 * the address is the whole capability (Konzept no. 36's rule for `edit_token`, restated for this one), so this view asks the server one question and
 * renders whatever comes back.
 *
 * **It is the fill-in view with the answers filled in**, exactly as the edit
 * view is — the questions, the paging, the validation and
 * the receipt all come from `fill/FillIn.tsx`. What is added here is the
 * frame: the note that this is a resumed draft rather than a fresh
 * registration, *Zwischenspeichern* wired to `PUT` instead of `POST`, and
 * *Entwurf verwerfen*, which neither of the other two public views has
 * anything like (DSGVO Art. 17 — the person a draft belongs to has no account
 * and no trash of their own, a review finding).
 */
export function ResponseDraftView({
  token,
}: {
  readonly token: string;
}): ReactElement {
  const query = useResponseDraft(token);

  if (query.isPending) {
    return (
      <main className="public" role="status">
        <p className="public__state">Entwurf wird geladen…</p>
      </main>
    );
  }

  // `query.data === undefined`, not `query.isError` — the same rule
  // `ResponseEditView` follows and for the same reason: a *background*
  // refetch that fails must not throw away what somebody is typing on a page
  // whose entire purpose is typing.
  if (query.data === undefined) {
    return <NotAvailable error={query.error} />;
  }

  return <Resuming token={token} data={query.data} />;
}

/**
 * Why this draft cannot be opened — **and the sentence comes from the
 * server**, the same rule `ResponseEditView.NotEditable` states: composing a
 * second set of sentences here would be a second answer to the same question,
 * and the two would drift.
 *
 * A 404 is deliberately vague: an unknown token, an expired draft
 * and one that was already submitted or discarded are one answer on the
 * server, byte-identical, and saying more here would undo that.
 */
function NotAvailable({ error }: { readonly error: unknown }): ReactElement {
  const refusal =
    error instanceof ApiError && error.status === 409
      ? error.refusal
      : undefined;

  const message =
    refusal?.message ??
    (error instanceof ApiError && error.status === 404
      ? 'Diese Adresse führt zu keinem Entwurf. Vielleicht ist der Link nicht vollständig, der Entwurf abgelaufen oder bereits abgesendet.'
      : 'Der Entwurf konnte nicht geladen werden. Bitte später erneut versuchen.');

  return (
    <main className="public" data-testid="response-draft-unavailable">
      <section className="public__card">
        <h1 className="public__title">Entwurf fortsetzen</h1>
        <p className="public__state" role="status">
          {message}
        </p>
      </section>
    </main>
  );
}

function Resuming({
  token,
  data,
}: {
  readonly token: string;
  readonly data: ResponseDraft;
}): ReactElement {
  const { form } = data;
  // *Zwischenspeichern* pressed again while resuming — `PUT`, not the `POST`
  // that mints an address (`PublicFormView`'s hook); one draft, one address.
  const updateDraft = useUpdateDraft(token);
  // The start token this page was loaded with — a fresh
  // one, minted for this resume rather than carried over from the sitting
  // that was broken off (restated for this route).
  const submit = useSubmitResponse(
    data.formSlug,
    form.startToken,
    undefined,
    token,
  );
  const deleteDraft = useDeleteDraft(token);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  /**
   * Driven by its own state rather than by `deleteDraft.isSuccess`: a second
   * press meeting the one 404 every gone token gets is **also** „verworfen"
   * from where the participant stands, not a failure to report — see the
   * comment at `onConfirm` below.
   */
  const [discarded, setDiscarded] = useState(false);
  /**
   * **The attachments that no longer exist** (a finding of the security review).
   *
   * The server has resolved the references against `file` — the same conditions
   * the claim makes when submitting —, and `expiresAt === null` is its
   * one answer for „würde jetzt abgelehnt". Here it becomes the set that
   * `FileField` marks beside the file name, instead of going on showing it as
   * attached.
   */
  const unavailableRefs = useMemo(
    () =>
      new Set(
        data.attachments
          .filter((attachment) => attachment.expiresAt === null)
          .map((attachment) => attachment.ref),
      ),
    [data.attachments],
  );

  if (discarded) {
    return <Discarded />;
  }

  return (
    <main
      className="public"
      data-tenant-theme=""
      style={tenantThemeStyle(form.tenant.branding)}
      data-testid="response-draft"
    >
      <TenantHeader tenant={form.tenant} />
      {/*
        `key={token}` — the fill-in state belongs to **one** draft, the same
        rule `ResponseEditView` and `PublicFormView` state for their own keys.
      */}
      <FillIn
        key={token}
        form={form}
        submit={submit}
        draft={updateDraft}
        initialAnswers={storedAnswers(form.definition, data.answers)}
        submitLabel="Absenden"
        pendingLabel="Wird gesendet…"
        intro={<ResumeNote data={data} />}
        /*
          **The draft's own upload door** — a finding from the acceptance run.
          This used to pass no `uploadTarget` at all, on the grounds that
          neither the slug-scoped door of a first fill-in nor the
          edit-token-scoped one of a correction fits a resumed draft. That was
          true and the conclusion was wrong: `FileField` then drew a disabled
          picker beside a live „Entfernen", so the only thing a participant on
          their second device could do to their attachment was **lose** it —
          on exactly the screen *Zwischenspeichern* exists for.

          The door is now `POST /public/drafts/<token>/files`
          (`PublicDraftFilesController`), running the draft's own refusal
          chain. The token in this address is the whole capability, the same
          rule this view states at the top for reading and writing the draft;
          it grants nothing an upload from the fill-in view would not.
        */
        uploadTarget={{ kind: 'draft', token }}
        /*
          **And which attachment the door can no longer save** (a finding of the
          security review). The door alone rebuilt the dead end on this
          screen: „entfernen → neu anhängen → **absenden**" presupposes the
          third step, which nothing enforces, and until then
          this view showed a file that had long since been collected as
          attached for thirty days. Now it says so.
        */
        unavailableRefs={unavailableRefs}
      />

      <section className="public__card" data-testid="response-draft-discard">
        {isDiscarding ? (
          <ConfirmPrompt
            question="Der Entwurf wird endgültig gelöscht. Das lässt sich nicht rückgängig machen."
            confirmLabel="Entwurf verwerfen"
            // Destructive, not reversible — the distinction Konzept no. 63's own
            // worklog measured in rendered colour (2026-08-03): unlike a
            // trash entry, a discarded draft does not come back after
            // 30 days. There is no trash here at all.
            tone="destructive"
            isPending={deleteDraft.isPending}
            onConfirm={() => {
              // The switch is deliberately **not** consulted for `DELETE`
              // (`PublicFormsService.deleteDraft`'s own comment: „a setting
              // that governs saving must not become a lock on the exit"), so
              // the only failures reaching here are „already gone" (404,
              // which is what a second press meets too — treated as success)
              // and a genuine network or server failure.
              deleteDraft.mutate(undefined, {
                onSuccess: () => {
                  setDiscarded(true);
                },
                onError: (error) => {
                  if (error instanceof ApiError && error.status === 404) {
                    setDiscarded(true);
                    return;
                  }
                  setDiscardError(
                    'Der Entwurf konnte nicht verworfen werden. Bitte erneut versuchen.',
                  );
                },
              });
            }}
            onCancel={() => {
              setIsDiscarding(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="public__secondary"
            onClick={() => {
              setIsDiscarding(true);
            }}
          >
            Entwurf verwerfen
          </button>
        )}
        {discardError === null ? null : (
          <p className="public__error" role="alert">
            {discardError}
          </p>
        )}
      </section>
      {/*
        The footer — here too. Whoever follows this link is the same person
        who filled the form in, and needs the same way to the
        privacy notice (`docs/legal/README.md` 5.3: „unter **jeder**
        öffentlichen Ansicht").
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

/** Shown once *Entwurf verwerfen* has landed — there is nothing left to type. */
function Discarded(): ReactElement {
  return (
    <main className="public" data-testid="response-draft-discarded">
      <section className="public__card">
        <h1 className="public__title">Entwurf verworfen</h1>
        <p className="public__state" role="status">
          Der Entwurf wurde gelöscht. Diese Adresse führt zu keinem
          Formularstand mehr.
        </p>
      </section>
    </main>
  );
}

/**
 * The one sentence that tells a participant where they are — the resume's
 * counterpart to `ResponseEditView`'s `EditNote`.
 *
 * Names what Konzept no. 58 and no. 63 ask to be said on this exact screen: when
 * the draft was last written, when it disappears, and that no account or
 * second factor stands behind the address that opened it — the same warning
 * the saved-address panel gives the moment a draft is created, restated for
 * the moment it is reopened.
 */
function ResumeNote({ data }: { readonly data: ResponseDraft }): ReactElement {
  return (
    <>
      <p className="public__edit-note" data-testid="response-draft-note">
        Dies ist ein zwischengespeicherter Entwurf. Zuletzt gespeichert am{' '}
        {formatDeadline(data.savedAt)}, gültig bis{' '}
        {formatDeadline(data.expiresAt)}. Jede Person, die diese Adresse kennt,
        kann ihn öffnen und weiter ausfüllen — ein Konto oder ein weiterer
        Nachweis ist dafür nicht nötig.
      </p>
      <AttachmentNote attachments={data.attachments} />
    </>
  );
}

/**
 * **The second, shorter period — the one that stood nowhere before** (a finding of the
 * security review).
 *
 * A draft is valid for up to thirty days, but its attachments only for 24 hours from
 * the upload (ADR-0014 no. 15): they do not yet belong to any answer, and the
 * purge collects what belongs to nobody. This view named the longer period in the
 * sentence above and the shorter one not at all — a participant learned of it
 * at the earliest at the `409` of their submission.
 *
 * The named point in time is the **earliest** of the attachments still alive, i.e.
 * the one from which something is missing. It comes from the server as a point in time and not as
 * a duration, for the reason `savedDraftSchema.expiresAt` names.
 *
 * Nothing, if the draft names no file — the great majority —, because a
 * hint about a period that concerns nobody waters down the sentence above.
 */
function AttachmentNote({
  attachments,
}: {
  readonly attachments: ResponseDraft['attachments'];
}): ReactElement | null {
  if (attachments.length === 0) {
    return null;
  }

  const gone = attachments.filter(
    (attachment) => attachment.expiresAt === null,
  ).length;
  const alive = attachments
    .map((attachment) => attachment.expiresAt)
    .filter((expiresAt): expiresAt is string => expiresAt !== null)
    .sort();
  const earliest = alive[0];

  return (
    <p className="public__edit-note" data-testid="response-draft-attachments">
      {gone === 0
        ? null
        : gone === 1
          ? 'Eine angehängte Datei ist nicht mehr verfügbar und im Formular gekennzeichnet — bitte dort entfernen und neu hochladen. '
          : `${String(gone)} angehängte Dateien sind nicht mehr verfügbar und im Formular gekennzeichnet — bitte dort entfernen und neu hochladen. `}
      {/*
        ⚠️ **The sentence stood here the wrong way round until 2026-08-12** and
        underestimated the retention: „24 Stunden nach dem Hochladen …, auch
        wenn der Entwurf länger gilt". An attachment on a draft by now has
        an **owner** (`draft_id`), and `file-purge.service.ts` expressly takes
        only files **without** an owner. An attachment therefore lives
        exactly as long as the draft it hangs on. The 24 hours still apply
        — but to a file that was uploaded and then used *nowhere*.
      */}
      Angehängte Dateien bleiben so lange erhalten wie dieser Entwurf
      {earliest === undefined
        ? ''
        : `; die nächste am ${formatDeadline(earliest)}`}
      .
    </p>
  );
}
