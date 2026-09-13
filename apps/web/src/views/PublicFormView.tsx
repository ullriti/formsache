import type { ReactElement } from 'react';
import { useState } from 'react';
import type { LockedPublicForm, PublicForm } from '@formsache/shared';

import {
  useDraftSaving,
  usePublicForm,
  useSubmitResponse,
} from '../api/public-form';
import { ApiError } from '../api/http';
import { FillIn } from '../fill/FillIn';
import { PasswordGate } from '../fill/PasswordGate';
import { TenantHeader } from '../fill/TenantHeader';
import { PublicLegalFooter } from '../fill/PublicLegalFooter';
import {
  unavailableNotice,
  type UnavailableNotice,
} from '../fill/unavailable-notice';
import { tenantThemeStyle } from '../styles/tenant-theme';

import './public-form-view.css';

/**
 * Filling in a form — **without a login** .
 *
 * Rendered outside the application shell and before any session check: a
 * participant has no account, and showing them a login form
 * would be the exact opposite of what this view promises. Nothing here reads
 * the session, and the API route it calls has no guard chain.
 *
 * **The pages, the fields and the receipt live in `fill/FillIn.tsx`** since
 * the requirement: the edit view is the same screen with the answers filled in,
 * and two copies of it would be two answers to every question about validation,
 * paging and the confirmation. What stays here is what is specific to a *first*
 * fill-in: the password gate, the availability notice, and the submission.
 */
export function PublicFormView({
  slug,
}: {
  readonly slug: string;
}): ReactElement {
  /*
   * The access proof of the requirement — **in component state and nowhere
   * else**.
   *
   * Not in `localStorage` and not in a cookie, deliberately. A public form is
   * filled in on borrowed devices — an organisation's office machine, a phone passed
   * around at a Mitgliederversammlung — and a proof that outlived the tab would leave the
   * next person in front of an open registration. Losing it on reload costs one
   * re-entry of a word the participant has in front of them; the proof itself
   * stays valid for an hour, so the server is not asked to do the work again.
   */
  const [proof, setProof] = useState<string | undefined>(undefined);
  const query = usePublicForm(slug, proof);

  if (query.isPending) {
    return (
      <main className="public" role="status">
        <p className="public__state">Formular wird geladen…</p>
      </main>
    );
  }

  /*
   * **Only when there was never any data** — the same distinction as in
   * `ResponseEditView`, and for the same reason.
   *
   * `isError` means "the last attempt failed", not "there is nothing to
   * show". A failed *background* refetch — `refetchOnReconnect`
   * after a connection loss, the `event_full` invalidation from
   * `api/public-form.ts` — leaves the last good data standing in the cache and
   * only sets the error flag. Replacing the whole page at this place with the
   * refusal threw away what the participant has typed: `FillIn` reads
   * `initialAnswers` **once**, what was typed is afterwards not
   * recoverable. On a page whose only purpose is the typing.
   *
   * The bug had already been found and fixed once in `ResponseEditView`
   * (in a review) — the *first fill-in* path had never got the fix,
   * although more is at stake there: the edit view can be opened again with
   * the link, an unsubmitted first registration cannot.
   */
  if (query.isError && query.data === undefined) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <main className="public">
        <p className="public__state" role="alert">
          {gone
            ? // Without „Anmeldung" (finding 32, second part): the same 404
              // answers a survey, a needs enquiry and an
              // Anmeldung. The form is already named in the first sentence, so
              // in the second the pronoun stands instead of a second „Formular".
              'Dieses Formular gibt es nicht. Vielleicht ist der Link abgelaufen oder es ist noch nicht geöffnet.'
            : 'Das Formular konnte nicht geladen werden. Bitte später erneut versuchen.'}
        </p>
      </main>
    );
  }

  /*
   * The requirement — the gate stands in front of everything else on this page.
   *
   * Before the availability notice on purpose: the server withholds the verdict
   * from a locked payload (there is nothing to judge with), and the order here
   * follows what arrived rather than deciding anything of its own. Somebody who
   * enters the word and finds the registration closed is told so on the next
   * render — the word never opens a closed form, it only gets past the gate.
   */
  if (query.data.locked) {
    return (
      <Locked
        slug={slug}
        form={query.data}
        onUnlocked={(granted) => {
          setProof(granted);
        }}
      />
    );
  }

  /*
   * The requirement, second half — a form nobody can hand in is not offered.
   *
   * The verdict is the server's (`availabilityOf()`, computed from the
   * effective settings and the server's clock, the requirement); nothing is judged
   * here. It is a **display** decision and not the enforcement: the deadline
   * that counts is the one checked when the submission arrives, because this
   * page may have been open since before it passed. Both exist for that reason
   * — this one so nobody fills in thirty fields for nothing, the server-side
   * one so it is actually refused.
   */
  const notice = unavailableNotice(query.data.availability);
  if (notice !== null) {
    return <Unavailable form={query.data} notice={notice} />;
  }

  return <Submitting slug={slug} form={query.data} proof={proof} />;
}

/** The locked stub, in the same frame the form itself gets. */
function Locked({
  slug,
  form,
  onUnlocked,
}: {
  readonly slug: string;
  readonly form: LockedPublicForm;
  readonly onUnlocked: (proof: string) => void;
}): ReactElement {
  return (
    <main
      className="public"
      data-tenant-theme=""
      style={tenantThemeStyle(form.tenant.branding)}
      data-testid="public-locked"
    >
      <TenantHeader tenant={form.tenant} />
      <PasswordGate slug={slug} form={form} onUnlocked={onUnlocked} />
      {/*
        The footer stands **on the locked preliminary stage as well**. Nothing
        is collected there yet, but the page is part of the process — and
        Art. 13 Abs. 1 DSGVO demands the information „zum Zeitpunkt der
        Erhebung", not afterwards (`docs/legal/README.md` 3.2).

        **Without the form-specific notice**, and that is a
        decision and no oversight (ADR-0028 no. 4): the locked payload
        carries title and organisation and nothing else — it is what a
        stranger sees *without* the access word. The notice stands on the same
        page as the first input field, so before any collection; delivering it
        here would mean handing the declared purpose of a protected form out to
        everyone who has the address.
      */}
      <PublicLegalFooter
        organisation={{
          shortName: form.tenant.shortName,
          name: form.tenant.name,
        }}
      />
    </main>
  );
}

function Unavailable({
  form,
  notice,
}: {
  readonly form: PublicForm;
  readonly notice: UnavailableNotice;
}): ReactElement {
  return (
    <main
      className="public"
      data-tenant-theme=""
      style={tenantThemeStyle(form.tenant.branding)}
      data-testid="public-unavailable"
    >
      <TenantHeader tenant={form.tenant} />
      <section className="public__card">
        <h1 className="public__title">{form.title}</h1>
        {/*
          `role="status"`, not `role="alert"`: the participant did nothing
          wrong, and this is the state of the page as it loaded rather than a
          failure of something they attempted.
        */}
        <p className="public__state" role="status">
          {notice.headline}
        </p>
        <p className="public__message">{notice.detail}</p>
      </section>
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

/** The fill-in screen plus the mutation that hands the answers in. */
function Submitting({
  slug,
  form,
  proof,
}: {
  readonly slug: string;
  readonly form: PublicForm;
  /** The access proof, for a form that had a gate. */
  readonly proof: string | undefined;
}): ReactElement {
  // *Zwischenspeichern* . The hook is always called — rules
  // of hooks — but never invoked unless `form.canSaveDraft` hands `FillIn` the
  // button that can call it (the evidence's first half: no control, not a
  // disabled one).
  //
  // `useDraftSaving`, not the bare `POST`: the first press creates the draft
  // and every press after it replaces that same one (a review finding —
  // see the hook for the measurement and for what happens when the draft
  // disappears between two presses).
  //
  // **Before the submission, because the submission reads its token.**
  const draft = useDraftSaving(slug, proof);
  // The token the server minted when this page loaded. It
  // travels back untouched — the browser neither reads nor refreshes it, and a
  // reload is what mints a new one.
  //
  // **And the draft this submission comes from** (a finding
  // of the security review). Since then the attachments of a
  // cached draft belong to **it**; a submission without its token
  // therefore names files that the claim may no longer take — measured:
  // `409 attachment_unavailable` for a file that stands in front of the
  // participant on the screen — and leaves the draft together with
  // half-filled-in personal answers standing for thirty days.
  // `ResponseDraftView` hands it on; here it was missing, and that was a
  // regression in the public fill-in path.
  //
  // `undefined` as long as nothing was cached on this page —
  // then it is the ordinary first fill-in, and the submission names
  // no draft.
  const submit = useSubmitResponse(slug, form.startToken, proof, draft.token);

  return (
    <main
      className="public"
      data-tenant-theme=""
      style={tenantThemeStyle(form.tenant.branding)}
    >
      <TenantHeader tenant={form.tenant} />
      {/* The upload door of this path: the slug, plus the
          access proof if this form had a gate — the same pair every other
          public request of this view carries. */}
      {/*
        `key={slug}` — the fill-in state belongs to **one** form.

        `FillIn` seeds its answers once and keeps them across every refetch, on
        purpose: a background refetch must not throw away what somebody is
        typing. The other side of that is that a change of *form* has to be a
        remount, or the answers to the previous one — and the event boxes'
        „diese Zahl stand schon da" of `EventField` — would carry over into a
        form they were never given to.
      */}
      <FillIn
        key={slug}
        form={form}
        submit={submit}
        // The requirement, the evidence: absent, not disabled, whenever this
        // read did not offer the button — `form.canSaveDraft` is the server's
        // verdict, evaluated fresh on every load, and nothing here repeats it.
        {...(form.canSaveDraft ? { draft: draft.save } : {})}
        uploadTarget={{
          kind: 'form',
          slug,
          ...(proof === undefined ? {} : { proof }),
        }}
      />
      {/*
        Under the form **and** under the confirmation page: `FillIn`
        renders both into the same frame, so the footer stands under both
        without a second decision. A link that one sees only on the
        confirmation page would be too late — one that is missing there would be
        the place at which somebody looks for the address for a revocation.
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
