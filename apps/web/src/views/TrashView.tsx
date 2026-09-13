import { TRASH_RETENTION_DAYS } from '@formsache/shared';
import type { ReactElement } from 'react';
import { useRef, useState } from 'react';
import type {
  DeletedForm,
  DeletedResponse,
  TrashPurgeResult,
} from '@formsache/shared';

import { ApiError } from '../api/http';
import type { RestoreResponseVariables } from '../api/trash';
import {
  useEmptyTrash,
  usePurgeForm,
  usePurgeResponse,
  useRestoreForm,
  useRestoreResponse,
  useTrash,
} from '../api/trash';
import { DASHBOARD_PATH } from '../router/routes';
import { navigate } from '../router/use-route';
import {
  actionErrorMessage,
  TRASH_EMPTY_SUBJECT,
  TRASH_PURGE_FORM_SUBJECT,
  TRASH_PURGE_RESPONSE_SUBJECT,
  TRASH_RESTORE_FORM_SUBJECT,
  TRASH_RESTORE_RESPONSE_SUBJECT,
} from './api-messages';
import { ConfirmPrompt } from './tenant-admin/ConfirmPrompt';

import './trash-view.css';

export interface TrashViewProps {
  /**
   * `canBuild && canViewResponses` of the **active membership**
   * — the pair „Endgültig löschen" and „Papierkorb leeren" require, on top of
   * the `canBuild` alone that already opened this page (`AppShell.tsx`).
   *
   * Organisation-wide, not per-form: a deleted form carries no per-form restriction
   * here (it is not in `useFormPermissions`' active list, and a restriction
   * only ever narrows a membership that already has less). Gating the two
   * controls on it is **comfort only** — the server asks the same pair again
   * on every one of the three routes, and an editor who somehow reaches a
   * control this prop would have hidden still only gets the 403 the guard
   * always gave (`purgeErrorMessage`, never a client verdict standing in for
   * it).
   */
  readonly canPurge: boolean;
}

/** A copy of `record` without `key` — clearing one row's error on retry. */
function withoutKey(
  record: Record<string, string>,
  key: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter(([entryKey]) => entryKey !== key),
  );
}

/** A copy of `ids` with `id` added — one row entering its in-flight state. */
function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.add(id);
  return next;
}

/** A copy of `ids` without `id` — that row's request has settled. */
function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/**
 * Trash (handoff §Screens/Views 10).
 *
 * Two sections with a counter each, straight off `GET /trash`
 * (`TrashService.view`, tenant-scoped and already filtered to what this
 * person may see — a form they are locked out of never appears here, and
 * neither do its answers). „↩ Wiederherstellen" is offered on every row;
 * „✕ Endgültig löschen" and „🗑 Papierkorb leeren" join it, but only for
 * whoever the `canPurge` prop says holds the stronger pair.
 *
 * **Both destructive controls ask first, inline, with `ConfirmPrompt"** — the
 * handoff's own wording for the bulk action („🗑 Papierkorb leeren (mit
 * Bestätigung)"), extended to the row-level one for the same reason: neither
 * has anywhere to come back from once the server has answered.
 *
 * **`canPurge` decides what renders, never what is allowed.** The three
 * routes behind these controls ask `canBuild` **and** `canViewResponses`
 * again on every request; hiding the buttons for somebody without the pair is
 * comfort so they are not shown a control they could press and then watch
 * refuse them, not the boundary itself (`CONTRIBUTING.md`).
 *
 * **No participant name on a response row.** The handoff's prototype shows
 * one, but `deletedResponseSchema` deliberately carries none — the trash
 * is a list of what can be brought back, not a second view onto personal
 * data (see the type's own comment in `@formsache/shared`). This view follows the
 * wire contract, not the mock data: the row reads by `formTitle` and the two
 * dates instead.
 *
 * **A restore can be refused** : the Antwortlimit or a
 * Veranstaltung filled up again while the answer was away. The row stays,
 * the server's own sentence appears under it, and the whole list is
 * refetched regardless of whether the attempt succeeded — a refusal is
 * evaluated against a moment that has already passed by the time it reaches
 * this screen, so the counters need a fresh read exactly when they did not
 * get what they asked for.
 *
 * **Focus after any of the five mutations goes to the view's own `<h1>`**,
 * never to the row or the section heading the action happened in: the row
 * (and, with the last one in a section, the section heading too) is removed
 * by the refetch that follows every success, and only the page title survives
 * every one of those shapes — the same reasoning `focusHeading` already
 * carried for restoring, now shared by purging and emptying too.
 */
export function TrashView({ canPurge }: TrashViewProps): ReactElement {
  const trash = useTrash();
  const restoreForm = useRestoreForm();
  const restoreResponse = useRestoreResponse();
  const purgeForm = usePurgeForm();
  const purgeResponse = usePurgeResponse();
  const emptyTrash = useEmptyTrash();
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [responseErrors, setResponseErrors] = useState<Record<string, string>>(
    {},
  );
  const [purgeFormErrors, setPurgeFormErrors] = useState<
    Record<string, string>
  >({});
  const [purgeResponseErrors, setPurgeResponseErrors] = useState<
    Record<string, string>
  >({});
  /**
   * The rows whose restore is in flight — a **set**, not the mutation's own
   * `variables`.
   *
   * One `useMutation` serves every row, and `variables` holds the arguments of
   * the *latest* call only: clicking row A and then row B made A's button look
   * idle again while its request was still open, and a second click on it sent
   * a second `POST` whose 404 („schon wiederhergestellt") was then written into
   * a row that no longer existed — an error nobody could see. The same shape
   * serves the two purges below, one `useMutation` each.
   */
  const [restoringForms, setRestoringForms] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [restoringResponses, setRestoringResponses] = useState<
    ReadonlySet<string>
  >(new Set());
  const [purgingForms, setPurgingForms] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [purgingResponses, setPurgingResponses] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /** Which row's „Endgültig löschen" confirmation is open — one at a time. */
  const [confirmingPurgeFormId, setConfirmingPurgeFormId] = useState<
    string | null
  >(null);
  const [confirmingPurgeResponseId, setConfirmingPurgeResponseId] = useState<
    string | null
  >(null);
  const [isConfirmingEmpty, setIsConfirmingEmpty] = useState(false);
  const [emptyError, setEmptyError] = useState<string | undefined>(undefined);
  const [emptyResult, setEmptyResult] = useState<TrashPurgeResult | undefined>(
    undefined,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Moves focus to the view's `<h1>` after any of the five writes below.
   *
   * **The `<h1>`, not the section or row the action happened in.** The row
   * carrying the pressed button is removed by the refetch that follows every
   * success, and with the last row of a section the section heading goes too
   * — the fully emptied trash unmounts the whole `trash__sections` block
   * and leaves focus on `<body>`, which is precisely the case neither a row
   * nor a section heading can cover. The title survives every one of those
   * states, so this lands somewhere either way.
   */
  const focusHeading = (): void => {
    headingRef.current?.focus();
  };

  const onRestoreForm = (id: string): void => {
    setFormErrors((prev) => withoutKey(prev, id));
    setRestoringForms((prev) => withId(prev, id));
    restoreForm.mutate(id, {
      onSuccess: focusHeading,
      onError: (error) => {
        setFormErrors((prev) => ({
          ...prev,
          [id]: actionErrorMessage(error, TRASH_RESTORE_FORM_SUBJECT),
        }));
      },
      onSettled: () => {
        setRestoringForms((prev) => withoutId(prev, id));
      },
    });
  };

  const onRestoreResponse = ({
    formId,
    responseId,
  }: RestoreResponseVariables): void => {
    setResponseErrors((prev) => withoutKey(prev, responseId));
    setRestoringResponses((prev) => withId(prev, responseId));
    restoreResponse.mutate(
      { formId, responseId },
      {
        onSuccess: focusHeading,
        onError: (error) => {
          setResponseErrors((prev) => ({
            ...prev,
            [responseId]: actionErrorMessage(
              error,
              TRASH_RESTORE_RESPONSE_SUBJECT,
            ),
          }));
        },
        onSettled: () => {
          setRestoringResponses((prev) => withoutId(prev, responseId));
        },
      },
    );
  };

  const onConfirmPurgeForm = (id: string): void => {
    setPurgeFormErrors((prev) => withoutKey(prev, id));
    setPurgingForms((prev) => withId(prev, id));
    purgeForm.mutate(id, {
      onSuccess: () => {
        setConfirmingPurgeFormId(null);
        focusHeading();
      },
      onError: (error) => {
        // Closes the confirmation rather than leaving it open next to the
        // error: both are `role="alert"`, and two live regions announcing at
        // once inside one row is the wrong way to say „das ging nicht".
        setConfirmingPurgeFormId(null);
        setPurgeFormErrors((prev) => ({
          ...prev,
          [id]: actionErrorMessage(error, TRASH_PURGE_FORM_SUBJECT),
        }));
      },
      onSettled: () => {
        setPurgingForms((prev) => withoutId(prev, id));
      },
    });
  };

  const onConfirmPurgeResponse = ({
    formId,
    responseId,
  }: RestoreResponseVariables): void => {
    setPurgeResponseErrors((prev) => withoutKey(prev, responseId));
    setPurgingResponses((prev) => withId(prev, responseId));
    purgeResponse.mutate(
      { formId, responseId },
      {
        onSuccess: () => {
          setConfirmingPurgeResponseId(null);
          focusHeading();
        },
        onError: (error) => {
          // Same reasoning as `onConfirmPurgeForm`'s `onError`.
          setConfirmingPurgeResponseId(null);
          setPurgeResponseErrors((prev) => ({
            ...prev,
            [responseId]: actionErrorMessage(
              error,
              TRASH_PURGE_RESPONSE_SUBJECT,
            ),
          }));
        },
        onSettled: () => {
          setPurgingResponses((prev) => withoutId(prev, responseId));
        },
      },
    );
  };

  const onOpenEmptyConfirm = (): void => {
    setEmptyError(undefined);
    setEmptyResult(undefined);
    setIsConfirmingEmpty(true);
  };

  const onConfirmEmpty = (): void => {
    emptyTrash.mutate(undefined, {
      onSuccess: (result) => {
        setIsConfirmingEmpty(false);
        setEmptyResult(result);
        focusHeading();
      },
      onError: (error) => {
        // Closes the confirmation, like all three of its siblings above: the
        // question and the error are both `role="alert"`, and two live regions
        // announcing at once is the wrong way to say „das ging nicht". Leaving
        // it open also offered the button that had just been refused.
        setIsConfirmingEmpty(false);
        setEmptyError(actionErrorMessage(error, TRASH_EMPTY_SUBJECT));
      },
    });
  };

  // Captured before any narrowing (`SuperadminView` does the same, see the
  // comment there): a query result's own `data` narrows to "never undefined"
  // the moment `isPending` is known false, which would turn the guard below
  // into a type error instead of the runtime check it has to stay for the
  // case that needs it — a query that has not settled yet.
  const trashDocument = trash.data;

  if (trash.isPending) {
    return (
      <div className="trash">
        <p className="trash__state" role="status">
          Papierkorb wird geladen…
        </p>
      </div>
    );
  }

  if (trashDocument === undefined) {
    return (
      <div className="trash">
        <p className="trash__state" role="alert">
          {loadErrorMessage(trash.error)}{' '}
          <button
            type="button"
            className="trash__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Zurück zum Dashboard
          </button>
        </p>
      </div>
    );
  }

  const { forms, responses } = trashDocument;
  const isEmpty = forms.length === 0 && responses.length === 0;

  return (
    <div className="trash">
      <div className="trash__head">
        <div className="trash__head-text">
          {/*
            `tabIndex={-1}` so a restore, a purge or an emptying can put focus
            here — see {@link focusHeading}. Not reachable by Tab, and
            `:focus-visible` (`base.css`) keeps the ring for the keyboard only.
          */}
          <h1 className="trash__title" ref={headingRef} tabIndex={-1}>
            Papierkorb
          </h1>
          {/*
            The **rule**, not a promise about machinery. „werden nach 30 Tagen
            automatisch entfernt" would say more than this screen can back up:
            `RetentionPurgeService` removes it, but on its own schedule, not to
            the second, so a form deleted today is not guaranteed to be gone
            the instant thirty days pass. What *is* true and provable here is
            the retention rule the Konzept states (DSGVO), so that is what
            this says.
          */}
          <p className="trash__subtitle">
            Gelöschte Formulare und Antworten · Aufbewahrungsfrist{' '}
            {String(TRASH_RETENTION_DAYS)} Tage
          </p>
        </div>

        {/*
          Hidden, not disabled, without `canPurge` — the same convention
          `AppHeader.tsx` and `MobileMenuSheet.tsx` use for a route nobody may
          open: `disabled` still takes a button out of the tab order and
          explains nothing, while an absent control asks no question a 403
          would then answer. It also disappears once the trash is empty —
          there being nothing left to empty.
        */}
        {canPurge && !isEmpty && !isConfirmingEmpty ? (
          <button
            type="button"
            className="trash__empty-open"
            data-testid="trash-empty-open"
            onClick={onOpenEmptyConfirm}
          >
            {/*
              A geometric character and not a colour emoji (finding 14): „🗑"
              renders from the emoji font, with its own glyph width and its own
              line box — it stood there larger than any other character of the
              application, although nothing about its class said so. „⊗" is the
              same character that the navigation gives the trash.
            */}
            <span aria-hidden="true">⊗ </span>
            Papierkorb leeren
          </button>
        ) : null}
      </div>

      {isConfirmingEmpty ? (
        <div className="trash__empty-confirm">
          <ConfirmPrompt
            question="Der gesamte Papierkorb wird endgültig geleert. Alle gelöschten Formulare und Antworten darin sind danach unwiderruflich weg — anders als das Löschen, das sie hierher gebracht hat, lässt sich das nicht mehr rückgängig machen."
            confirmLabel="Papierkorb leeren"
            tone="destructive"
            isPending={emptyTrash.isPending}
            onConfirm={onConfirmEmpty}
            onCancel={() => {
              setIsConfirmingEmpty(false);
            }}
          />
        </div>
      ) : null}

      {emptyError === undefined ? null : (
        <p
          className="trash__empty-result trash__empty-result--warning"
          role="alert"
          data-testid="trash-empty-error"
        >
          {emptyError}
        </p>
      )}

      {emptyResult === undefined ? null : (
        <EmptyResultSummary result={emptyResult} />
      )}

      {isEmpty ? (
        // `role="status"` so the emptying is *heard*, not only seen: the
        // common restore is the last one, and without a live region a screen
        // reader gets nothing back from the click but a moved focus.
        <div className="trash__empty" role="status">
          <span className="trash__empty-icon" aria-hidden="true">
            🗑
          </span>
          <p className="trash__empty-title">Papierkorb ist leer</p>
          <p className="trash__empty-hint">
            Gelöschte Formulare und Antworten erscheinen hier.
          </p>
        </div>
      ) : (
        <div className="trash__sections">
          <section
            className="trash__section"
            aria-labelledby="trash-forms-heading"
          >
            <div className="trash__section-head">
              <h2 className="trash__section-title" id="trash-forms-heading">
                Gelöschte Formulare
              </h2>
              <span className="trash__count" data-testid="trash-forms-count">
                {forms.length}
              </span>
            </div>
            {forms.length === 0 ? (
              <p className="trash__section-empty">
                Keine gelöschten Formulare.
              </p>
            ) : (
              forms.map((form) => (
                <DeletedFormRow
                  key={form.id}
                  form={form}
                  onRestore={() => {
                    onRestoreForm(form.id);
                  }}
                  isRestoring={restoringForms.has(form.id)}
                  error={formErrors[form.id]}
                  canPurge={canPurge}
                  isConfirmingPurge={confirmingPurgeFormId === form.id}
                  onRequestPurge={() => {
                    setConfirmingPurgeFormId(form.id);
                  }}
                  onCancelPurge={() => {
                    setConfirmingPurgeFormId(null);
                  }}
                  onConfirmPurge={() => {
                    onConfirmPurgeForm(form.id);
                  }}
                  isPurging={purgingForms.has(form.id)}
                  purgeError={purgeFormErrors[form.id]}
                />
              ))
            )}
          </section>

          <section
            className="trash__section"
            aria-labelledby="trash-responses-heading"
          >
            <div className="trash__section-head">
              <h2 className="trash__section-title" id="trash-responses-heading">
                Gelöschte Antworten
              </h2>
              <span
                className="trash__count"
                data-testid="trash-responses-count"
              >
                {responses.length}
              </span>
            </div>
            {responses.length === 0 ? (
              <p className="trash__section-empty">
                Keine gelöschten Antworten.
              </p>
            ) : (
              responses.map((response) => (
                <DeletedResponseRow
                  key={response.id}
                  response={response}
                  onRestore={() => {
                    onRestoreResponse({
                      formId: response.formId,
                      responseId: response.id,
                    });
                  }}
                  isRestoring={restoringResponses.has(response.id)}
                  error={responseErrors[response.id]}
                  canPurge={canPurge}
                  isConfirmingPurge={confirmingPurgeResponseId === response.id}
                  onRequestPurge={() => {
                    setConfirmingPurgeResponseId(response.id);
                  }}
                  onCancelPurge={() => {
                    setConfirmingPurgeResponseId(null);
                  }}
                  onConfirmPurge={() => {
                    onConfirmPurgeResponse({
                      formId: response.formId,
                      responseId: response.id,
                    });
                  }}
                  isPurging={purgingResponses.has(response.id)}
                  purgeError={purgeResponseErrors[response.id]}
                />
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * What „🗑 Papierkorb leeren" actually did — {@link TrashPurgeResult} in words
 * (the finding that a purge run empties only one batch at a time).
 *
 * **`remaining` is not a courtesy count.** The server walks the trash in
 * batches of `TRASH_PURGE_BATCH_SIZE`; an organisation with more than that still has
 * items after this call, and the sentence below says so and points at the
 * button that is still on screen (it stays, `TrashView` only removes it once
 * the trash is actually empty) rather than letting somebody believe one
 * click finished the job.
 *
 * **`failed` gets its own sentence, in `role="alert"`.** A file the storage
 * would not release leaves its row standing (ADR-0014 no. 16) — a number
 * folded into „removed" would say something that did not happen.
 *
 * **…and the two numbers have to be read together.** `remaining` is counted,
 * not inferred (`TrashService.empty`), so it **includes** the elements that
 * just failed. With `remaining ≤ failed` there is nothing left but those, and
 * „bitte erneut drücken, um fortzufahren" then asks for a run that brings back
 * the same elements, the same errors and the same number — an invitation to
 * mistake standstill for progress. The retry sentence is therefore offered only
 * while `remaining > failed`; otherwise this says that pressing again changes
 * nothing, which is the honest half of the same measurement.
 */
function EmptyResultSummary({
  result,
}: {
  readonly result: TrashPurgeResult;
}): ReactElement {
  const { forms, responses, failed, remaining } = result;
  return (
    <div
      className="trash__empty-result"
      role={failed > 0 ? 'alert' : 'status'}
      data-testid="trash-empty-result"
    >
      <p>
        {forms === 0 && responses === 0
          ? 'Es wurde nichts endgültig gelöscht.'
          : `${String(forms)} Formular(e) und ${String(responses)} Antwort(en) wurden endgültig gelöscht.`}
      </p>
      {failed > 0 ? (
        <p data-testid="trash-empty-failed">
          {failed} Element(e) konnten nicht endgültig gelöscht werden und
          bleiben im Papierkorb.
        </p>
      ) : null}
      {remaining > 0 ? (
        <p data-testid="trash-empty-remaining">
          {remaining > failed
            ? `Es sind noch ${String(remaining)} Element(e) im Papierkorb — bitte „Papierkorb leeren" erneut drücken, um fortzufahren.`
            : `Es sind noch ${String(remaining)} Element(e) im Papierkorb — es sind genau die, die eben gescheitert sind. Ein erneuter Durchlauf ändert daran nichts.`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why the list could not be read.
 *
 * **A 403 shows the server's own sentence where there is one.** Two different
 * guards answer 403 on `GET /trash` and only one of them is about a role:
 * `TenantScopeGuard` („Für diese Anfrage ist keine Organisation ausgewählt.") fires when
 * the session has no tenant scope — during a switch, or after the active
 * membership was withdrawn while the session was open — and
 * `GroupPermissionGuard` („Diese Aktion ist für Ihre Rolle nicht freigegeben.")
 * when `can_build` is missing. The status alone cannot tell them apart, and
 * answering both with the role sentence asked somebody to obtain a permission
 * they already had. Both server sentences are written for this screen, so both
 * are shown as sent; the role sentence below stays as the fallback for a 403
 * whose body could not be read at all.
 */
function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return (
      error.detail ?? 'Der Papierkorb ist der Rolle „Bearbeiten" vorbehalten.'
    );
  }
  return 'Der Papierkorb konnte nicht geladen werden.';
}

/** `Date.toLocaleDateString` — the same formatting `DashboardView` uses. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE');
}

interface PurgeRowProps {
  readonly canPurge: boolean;
  readonly isConfirmingPurge: boolean;
  readonly onRequestPurge: () => void;
  readonly onCancelPurge: () => void;
  readonly onConfirmPurge: () => void;
  readonly isPurging: boolean;
  readonly purgeError: string | undefined;
}

interface DeletedFormRowProps extends PurgeRowProps {
  readonly form: DeletedForm;
  readonly onRestore: () => void;
  readonly isRestoring: boolean;
  readonly error: string | undefined;
}

/** One row of „Gelöschte Formulare" (handoff §Screens/Views 10). */
function DeletedFormRow({
  form,
  onRestore,
  isRestoring,
  error,
  canPurge,
  isConfirmingPurge,
  onRequestPurge,
  onCancelPurge,
  onConfirmPurge,
  isPurging,
  purgeError,
}: DeletedFormRowProps): ReactElement {
  return (
    <div className="trash-row" data-testid="trash-deleted-form">
      <span className="trash-row__icon" aria-hidden="true">
        📄
      </span>
      <div className="trash-row__body">
        <p className="trash-row__title">{form.title}</p>
        <p className="trash-row__meta">
          {form.responseCount === 1
            ? '1 Antwort'
            : `${String(form.responseCount)} Antworten`}
          {' · gelöscht '}
          {formatDate(form.deletedAt)}
        </p>
        {error === undefined ? null : (
          <p className="trash-row__error" role="alert">
            {error}
          </p>
        )}
        {purgeError === undefined ? null : (
          <p className="trash-row__error" role="alert">
            {purgeError}
          </p>
        )}
      </div>
      <div className="trash-row__actions">
        <button
          type="button"
          className="trash-row__restore"
          data-testid="trash-restore-form"
          onClick={onRestore}
          disabled={isRestoring}
        >
          <span aria-hidden="true">↩ </span>
          {isRestoring ? 'Wird wiederhergestellt…' : 'Wiederherstellen'}
        </button>
        {canPurge ? (
          <button
            type="button"
            className="trash-row__purge"
            data-testid="trash-purge-form"
            // **The name names the form** (a review finding).
            // The visible text is the same as that of the confirmation below
            // it, so with the query open two controls with *one* name stand in
            // the same area — for a keyboard or screen-reader operation it is
            // then not distinguishable which of the two one is currently
            // activating (WCAG 2.5.3). The trash has the same ambiguity
            // moreover **per row**: seven rows carry seven identical buttons.
            // Both are solved by the same addition — the same answer as with the
            // stripe colour pickers („Streifenfarbe 2 von 3").
            aria-label={`„${form.title}" endgültig löschen`}
            onClick={onRequestPurge}
            disabled={isPurging || isConfirmingPurge}
          >
            <span aria-hidden="true">✕ </span>
            {isPurging ? 'Wird endgültig gelöscht…' : 'Endgültig löschen'}
          </button>
        ) : null}
      </div>
      {isConfirmingPurge ? (
        <div className="trash-row__confirm">
          <ConfirmPrompt
            question={`„${form.title}" wird mit allen zugehörigen Antworten endgültig gelöscht. Das lässt sich nicht rückgängig machen.`}
            confirmLabel="Endgültig löschen"
            tone="destructive"
            isPending={isPurging}
            onConfirm={onConfirmPurge}
            onCancel={onCancelPurge}
          />
        </div>
      ) : null}
    </div>
  );
}

interface DeletedResponseRowProps extends PurgeRowProps {
  readonly response: DeletedResponse;
  readonly onRestore: () => void;
  readonly isRestoring: boolean;
  readonly error: string | undefined;
}

/**
 * One row of „Gelöschte Antworten" (handoff §Screens/Views 10) — by form and
 * date, never by participant name (see the module docblock on why).
 */
function DeletedResponseRow({
  response,
  onRestore,
  isRestoring,
  error,
  canPurge,
  isConfirmingPurge,
  onRequestPurge,
  onCancelPurge,
  onConfirmPurge,
  isPurging,
  purgeError,
}: DeletedResponseRowProps): ReactElement {
  return (
    <div className="trash-row" data-testid="trash-deleted-response">
      <span
        className="trash-row__icon trash-row__icon--response"
        aria-hidden="true"
      >
        ▤
      </span>
      <div className="trash-row__body">
        <p className="trash-row__title">{response.formTitle}</p>
        <p className="trash-row__meta">
          eingereicht {formatDate(response.submittedAt)}
          {' · gelöscht '}
          {formatDate(response.deletedAt)}
        </p>
        {error === undefined ? null : (
          <p className="trash-row__error" role="alert">
            {error}
          </p>
        )}
        {purgeError === undefined ? null : (
          <p className="trash-row__error" role="alert">
            {purgeError}
          </p>
        )}
      </div>
      <div className="trash-row__actions">
        <button
          type="button"
          className="trash-row__restore"
          data-testid="trash-restore-response"
          onClick={onRestore}
          disabled={isRestoring}
        >
          <span aria-hidden="true">↩ </span>
          {isRestoring ? 'Wird wiederhergestellt…' : 'Wiederherstellen'}
        </button>
        {canPurge ? (
          <button
            type="button"
            className="trash-row__purge"
            data-testid="trash-purge-response"
            // As in the form row above, and here additionally necessary:
            // several answers of the same form carry the same title, so what
            // distinguishes them is only the moment of submission — exactly what
            // the row visibly displays as well.
            aria-label={`Antwort zu „${response.formTitle}" vom ${formatDate(response.submittedAt)} endgültig löschen`}
            onClick={onRequestPurge}
            disabled={isPurging || isConfirmingPurge}
          >
            <span aria-hidden="true">✕ </span>
            {isPurging ? 'Wird endgültig gelöscht…' : 'Endgültig löschen'}
          </button>
        ) : null}
      </div>
      {isConfirmingPurge ? (
        <div className="trash-row__confirm">
          <ConfirmPrompt
            question={`Diese Antwort zu „${response.formTitle}" wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.`}
            confirmLabel="Endgültig löschen"
            tone="destructive"
            isPending={isPurging}
            onConfirm={onConfirmPurge}
            onCancel={onCancelPurge}
          />
        </div>
      ) : null}
    </div>
  );
}
