import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import type {
  AnswerValue,
  FormSettings,
  PublicTenant,
  SubmitResponseResponse,
} from '@formsache/shared';
import { SYSTEM_FORM_SETTINGS, sampleAnswers } from '@formsache/shared';

import { useForm } from '../api/forms';
import { useNotifications } from '../api/notifications';
import { useFormSettings } from '../api/settings';
import { useBuilderStore } from '../builder/builder-store';
import { DraftGuardDialog } from '../builder/DraftGuardDialog';
import { useDraftGuard } from '../builder/use-draft-guard';
import { FillIn, type SubmitController } from '../fill/FillIn';
import { TenantHeader } from '../fill/TenantHeader';
import { TestRunPanel } from './preview/TestRunPanel';

import './public-form-view.css';
import './preview-view.css';

/**
 * **The test mode** — the preview view of the handoff, the requirement from
 * concept no. 28.
 *
 * An editor fills in their own form the way a participant would see it, with a
 * button that enters valid sample values — and a trial run that shows what would
 * go out on a real submission.
 *
 * ## The three boundaries from concept no. 28, and where they stand here
 *
 * 1. **Never under the public address.** This view hangs on
 *    `/forms/:id/preview`, behind the login, and reads `GET
 *    /forms/:id` — the **draft** that the builder writes. There is no flag that
 *    would be passed through `/f/<address>`; the public route knows nothing of
 *    this mode, and that is not a convenience but the boundary itself: a button
 *    „mit Beispielwerten füllen" on the form that a whole organisation receives
 *    would be a tool for trashing the evaluation.
 * 2. **The values come from the shared schema.** `sampleAnswers`
 *    (`packages/shared/src/sample-answers.ts`) generates them and checks every
 *    candidate against `answerSchemaFor` of the same question. This file
 *    contains not a single rule about what a valid value looks like — it calls a
 *    function and displays the result.
 * 3. **Same form, same values.** The generator is deterministic; this view adds
 *    nothing that would not be (the date of the trial run is fixed too, see
 *    `TestRunPanel`).
 *
 * ## Why this view does not submit anything — and how one sees that
 *
 * `FillIn` is given a {@link SubmitController} that is **not a mutation**: it
 * calls no route, but remembers the answers and reports success. That is the
 * promise in its tersest form — there is no write path here that a condition
 * could release one day. A `response` row and a `mail_log` row cannot come into
 * being, because nothing exists that could create them.
 *
 * For the same reason `FillIn` gets **no** `draft` controller: an intermediate
 * save would write a row, and „does not save" tolerates no exception (the banner
 * says it in the same words).
 */
export interface PreviewViewProps {
  readonly formId: string;
  /**
   * The organisation as its header shows it — from the active membership, never
   * from a public payload: this page knows no public address (boundary 1).
   */
  readonly tenant: PublicTenant | undefined;
  /**
   * Whether this person may build on **this** form — the condition on which the
   * test mode hangs (`FormNav`).
   *
   * **Passed in and enforced here, not just hidden in the menu** (a rework, a
   * review finding). The three comments — here, in `AppShell` and in `FormNav` —
   * claimed „the test mode hangs on `canBuild`", and this view did not even know
   * the flag: *measured on 2026-08-05*, `/forms/<id>/preview` was fully
   * reachable through the address bar for anyone who only had
   * `canViewResponses`; hidden was the navigation entry alone.
   *
   * **A boundary it is nevertheless not** (`CONTRIBUTING.md`): the boundary is
   * the guard in front of `GET /forms/:id`, and that one shows an evaluator the
   * draft anyway — nothing flowed out here that `canViewResponses` did not
   * already grant. It is enforced so that the promise holds: a view whose entry
   * is hidden while it itself stands open is a promise that only the text makes.
   */
  readonly canBuild: boolean;
  /**
   * Whether this person may read settings and notifications **of this form**.
   *
   * The test mode itself hangs on `canBuild`; the display (progress, page
   * numbers, mandatory hint), the confirmation texts and the list of
   * notifications lie behind `canManageFormSettings`
   * (`FormSettingsController`, `NotificationsController`). Without the
   * permission it is **not even asked** instead of fetching two 403s — and the
   * view says what it is therefore missing.
   *
   * Since ADR-0021 that is **not** the organisation-wide `can_manage_settings`:
   * the two routes behind it demand the permission per form. Under the old flag
   * this view did not even ask for the default group `editor` — and fetched two
   * 403s for a group that only had the broad permission.
   */
  readonly canManageFormSettings: boolean;
}

export function PreviewView({
  formId,
  tenant,
  canBuild,
  canManageFormSettings,
}: PreviewViewProps): ReactElement {
  // Without `canBuild` it is **not even asked** — the same rule by which
  // settings and notifications stay unasked under their permission.
  const form = useForm(formId, canBuild);
  const settings = useFormSettings(formId, canBuild && canManageFormSettings);
  const notifications = useNotifications(
    formId,
    canBuild && canManageFormSettings,
  );

  /**
   * The answers of the view — the state `FillIn` starts with.
   *
   * A counter next to it so that „Beispielwerte eintragen" has an effect:
   * `FillIn` reads `initialAnswers` **once** (on purpose — a background refetch
   * must not take anybody's typing away), so the only honest way to set new
   * initial values is a rebuild through `key`. That is at the same time the
   * behaviour of the prototype: „↻ Formular erneut testen" starts from the
   * beginning.
   */
  const [seeded, setSeeded] = useState<{
    readonly answers: Record<string, AnswerValue>;
    readonly generation: number;
  }>({ answers: {}, generation: 0 });
  /**
   * The answers of the last trial run — `null` as long as none has run.
   *
   * `unknown` per key, because `PublicSubmission` says so: what `FillIn` hands
   * out is the state of an input mask in which a half-typed number stands as a
   * string. The test run parses every value individually (`run-context.ts`)
   * instead of asserting it.
   */
  const [run, setRun] = useState<Readonly<Record<string, unknown>> | null>(
    null,
  );

  /**
   * **The state from the builder, if one lies there** — review finding 21b.
   *
   * Until now the preview read exclusively `GET /forms/:id`, that is the
   * *saved* draft, and the builder emptied its store on leaving: switching to
   * this tab therefore did not show what was just being built, but the last
   * saved state — and threw away the typing in doing so. Now the document stays
   * in the store (`BuilderView`), and this view shows it.
   *
   * **No mirroring of server data** (`CONTRIBUTING.md`): what is read is the
   * state of the editor, not the cache; nothing is written here. If no document
   * for *this* form lies in the store — called directly, discarded, just
   * reloaded — the server state stays the source.
   *
   * Four individual selectors instead of one object: a selector that builds a
   * new object on every call never has the same snapshot for
   * `useSyncExternalStore` and spins endlessly.
   */
  const draftFormId = useBuilderStore((state) => state.formId);
  const draftPages = useBuilderStore((state) => state.pages);
  const draftTitle = useBuilderStore((state) => state.title);
  const draftIsDirty = useBuilderStore((state) => state.isDirty);
  const hasDraft = draftFormId === formId && draftPages.length > 0;

  /** The leave dialog applies here too — see {@link useDraftGuard}. */
  const guard = useDraftGuard({ formId, canSave: canBuild });

  const definition = useMemo(
    () => (hasDraft ? { pages: draftPages } : form.data?.definition),
    [hasDraft, draftPages, form.data],
  );

  /**
   * The sample values of this form — **computed once per draft**.
   *
   * `useMemo` and not „on click": the result hangs on the definition alone (the
   * generator is deterministic), and the findings (`unfillable`) are something
   * one wants to know even when one has not yet pressed the button — they are a
   * statement about the form.
   *
   * **And that applies by now to what is rendered as well.** The findings block
   * hung on a state of its own with initial value `[]`, set only in the click
   * handler and emptied again by „↻ erneut testen": *measured on 2026-08-05*
   * the findings text was not visible before the click, visible after the click,
   * gone again after „erneut testen" — a state about the operation, where the
   * comment promised a statement about the form. What is rendered now is
   * `generated.unfillable` itself; a second place in which the same list stands
   * can no longer diverge that way.
   */
  const generated = useMemo(
    () => (definition === undefined ? null : sampleAnswers(definition)),
    [definition],
  );

  /**
   * The effective settings — those of the server, or the shipped ones.
   *
   * The fallback is **`SYSTEM_FORM_SETTINGS`**, that is exactly what a form
   * shows whose organisation and whose own page have overridden nothing. It is
   * not an invented state and it is named (see `settingsNote`): a preview that
   * silently showed foreign values would be worse than one that says what it is
   * missing.
   */
  const effective: FormSettings =
    settings.data?.effective ?? SYSTEM_FORM_SETTINGS;

  const settingsNote = !canManageFormSettings
    ? 'Darstellung, Bestätigungstexte und Benachrichtigungen brauchen das Recht „Formular-Einstellungen". Gezeigt werden hier die ausgelieferten Vorgaben.'
    : settings.isError
      ? 'Die Einstellungen dieses Formulars ließen sich nicht laden. Gezeigt werden die ausgelieferten Vorgaben.'
      : null;

  const notificationsNote = !canManageFormSettings
    ? 'Welche E-Mails hinausgingen, lässt sich ohne das Recht „Formular-Einstellungen" nicht anzeigen.'
    : notifications.isError
      ? 'Die Benachrichtigungen dieses Formulars ließen sich nicht laden.'
      : null;

  /*
    The dialog belongs in **every** return path of this view: the lock hangs on
    the store, not on the loading state, and an intercepted click without a
    visible query would be a navigation that simply does not take place.
  */
  const guardDialog =
    guard.pending === null ? null : (
      <DraftGuardDialog
        busy={guard.busy}
        error={guard.error}
        canSave={guard.canSave}
        onSave={guard.onSave}
        onDiscard={guard.onDiscard}
        onCancel={guard.onCancel}
      />
    );

  if (!canBuild) {
    return (
      <section className="preview">
        <p className="preview__state" role="status">
          Der Testmodus steht nur denen offen, die dieses Formular bearbeiten
          dürfen.
        </p>
        {/*
          Here too — „every return path" includes the one in which the
          permission has just been withdrawn: the draft in the store stays
          untouched by that, so the lock still stands, and without the dialog
          this view would swallow every navigation click without a word.
        */}
        {guardDialog}
      </section>
    );
  }

  if (form.isPending) {
    return (
      <section className="preview">
        <p className="preview__state" role="status">
          Formular wird geladen…
        </p>
        {guardDialog}
      </section>
    );
  }

  if (
    form.data === undefined ||
    definition === undefined ||
    generated === null
  ) {
    return (
      <section className="preview">
        <p className="preview__state" role="alert">
          Das Formular konnte nicht geladen werden. Bitte später erneut
          versuchen.
        </p>
        {guardDialog}
      </section>
    );
  }

  const detail = form.data;
  /** The name the preview shows — from the builder, if one stands there. */
  const shownTitle = hasDraft ? draftTitle : detail.title;

  /**
   * The „Absenden" button of the test mode — **a dummy on purpose**.
   *
   * No `useMutation`, no `fetch`, no address: `mutate` writes the answers into
   * the state of this view and reports success. `FillIn` checks its page
   * beforehand as always (mandatory fields, schema), so the trial run is exactly
   * as strict as a real submission — only without the row that a real one leaves
   * behind.
   *
   * The confirmation texts are the **effective** ones of the form, so that an
   * editor sees the page a participant would get. `redirect: null` is the one
   * deliberate deviation: a redirect with a countdown would carry the editor out
   * of their own preview; that it exists stands instead as a sentence in the
   * test run area. `editUrl: null`, because no answer exists that could be
   * edited.
   */
  const submit: SubmitController = {
    isPending: false,
    isError: false,
    error: null,
    mutate: (submission, options) => {
      setRun(submission.answers);
      const result: SubmitResponseResponse = {
        confirmationTitle: effective.confirmTitle,
        confirmationMessage: effective.confirmMsg,
        redirect: null,
        editUrl: null,
      };
      options.onSuccess(result);
    },
  };

  return (
    <section className="preview">
      {/*
        The banner of the handoff, word for word („● Testmodus · Eingaben werden
        nicht gespeichert oder versendet."). `role="status"` instead of `alert`:
        it is the state of the page, not a failure.
      */}
      <p className="preview__banner" role="status" data-testid="test-mode-bar">
        <span className="preview__banner-mark">● Testmodus</span>
        <span className="preview__banner-text">
          Eingaben werden nicht gespeichert oder versendet.
        </span>
      </p>

      {/*
        **The unsaved state is named** — review finding 21b. Without this
        sentence the preview would be a view that shows something other than
        what the server has, without anybody being able to see it; „this is how
        it looks" would then hold only for the editor themselves and for nobody
        they send the link to.
      */}
      {hasDraft && draftIsDirty ? (
        <p
          className="preview__note preview__note--draft"
          role="status"
          data-testid="preview-draft-note"
        >
          Diese Vorschau zeigt den <strong>ungespeicherten</strong> Stand aus
          dem Builder – nicht die gespeicherte Fassung.
        </p>
      ) : null}

      <div className="preview__toolbar">
        <button
          type="button"
          className="preview__action preview__action--primary"
          onClick={() => {
            setSeeded((current) => ({
              answers: generated.answers,
              generation: current.generation + 1,
            }));
            setRun(null);
          }}
        >
          Beispielwerte eintragen
        </button>
        <button
          type="button"
          className="preview__action"
          onClick={() => {
            setSeeded((current) => ({
              answers: {},
              generation: current.generation + 1,
            }));
            setRun(null);
          }}
        >
          ↻ Formular erneut testen
        </button>
      </div>

      {settingsNote === null ? null : (
        <p className="preview__note" role="status">
          {settingsNote}
        </p>
      )}

      {/*
        **The finding, not the excuse** : if the generator finds no valid value
        for a field, that field's rules contradict each other — a whole number
        between two fractions, a pattern that does not go together with the
        minimum length. The fields are **named**; a generator that enters just
        anything here swallows exactly the yield it exists for.

        **From the first frame on, not only after the click** : the block stands
        on `generated.unfillable`, that is on the statement about this form, and
        not on a state that only „Beispielwerte eintragen" fills and „↻ erneut
        testen" empties again.
      */}
      {generated.unfillable.length === 0 ? null : (
        <div className="preview__findings" role="status">
          <p className="preview__findings-title">
            Für diese Felder ließ sich kein gültiger Beispielwert erzeugen –
            ihre Regeln widersprechen sich vermutlich (etwa eine Mindestlänge,
            die zum Muster nicht passt, oder ein Bereich ohne ganze Zahl):
          </p>
          <ul className="preview__findings-list">
            {generated.unfillable.map((finding) => (
              <li key={finding.questionId}>{finding.label}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="public preview__stage">
        {tenant === undefined ? null : <TenantHeader tenant={tenant} />}
        <FillIn
          /*
            A rebuild per „Beispielwerte eintragen" or „erneut testen":
            `FillIn` reads `initialAnswers` only once on purpose, so that a
            refetch takes nobody's typing away. The key additionally carries the
            form id, so that a change of form never drags answers along — the
            same rule that `PublicFormView` sets up with `key={slug}`.
          */
          key={`${formId}:${String(seeded.generation)}`}
          form={{
            title: shownTitle,
            definition,
            display: {
              showProgress: effective.showProgress,
              showPageNumbers: effective.showPageNumbers,
              showRequiredHint: effective.showRequiredHint,
            },
            /*
              **Empty, and that is the statement.** Remaining seats are the state
              of the real registrations; they come from the public route, which
              this view does not call (boundary 1). A trial run occupies no seat
              and therefore does not show one as occupied either.
            */
            eventSeats: [],
          }}
          submit={submit}
          initialAnswers={seeded.answers}
          submitLabel="Testlauf starten"
          intro={
            <p className="preview__intro">
              So sieht das Formular für eine ausfüllende Person aus. Der
              Testlauf schickt nichts ab – er zeigt, was hinausginge.
            </p>
          }
        />
      </div>

      {run === null ? null : (
        <>
          <TestRunPanel
            definition={definition}
            formTitle={shownTitle}
            tenantName={tenant?.name ?? 'Organisation'}
            answers={run}
            notifications={
              canManageFormSettings ? notifications.data : undefined
            }
            notificationsNote={notificationsNote}
          />
          {/*
            The redirect is **named instead of carried out** — see `submit`
            above. A countdown that carries the editor out of their own preview
            would be the one place where the preview does something instead of
            showing something.
          */}
          {effective.redirectEnabled && effective.redirectUrl !== null ? (
            <p className="preview__note" role="status">
              Nach dem Absenden würde eine Teilnehmerin nach{' '}
              {effective.redirectUrl} weitergeleitet (nach{' '}
              {String(effective.redirectDelay)} Sekunden). Im Testmodus
              geschieht das nicht.
            </p>
          ) : null}
        </>
      )}

      {/*
        The query applies from here too: the unsaved draft still lies in the
        store, and a way from the preview to the dashboard would lose it just as
        one from the builder would. A lock that only the builder knows would be
        a lock with an open door next to it.
      */}
      {guardDialog}
    </section>
  );
}
