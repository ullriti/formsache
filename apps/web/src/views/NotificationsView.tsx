import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  addressQuestionsOf,
  allQuestions,
  type Notification,
} from '@formsache/shared';

import { useForm } from '../api/forms';
import { ApiError } from '../api/http';
import {
  useCreateNotification,
  useDeleteNotification,
  useInheritedReplyTo,
  useNotificationTemplates,
  useNotifications,
  useUpdateNotification,
} from '../api/notifications';
import { DASHBOARD_PATH, builderPath, mailLogPath } from '../router/routes';
import { navigate } from '../router/use-route';
import { NotificationEditor } from './notifications/NotificationEditor';
import {
  draftOf,
  draftProblems,
  emptyDraft,
  isDirty as isDraftDirty,
  toWriteRequest,
  type NotificationDraft,
} from './notifications/notification-draft';
import { sampleContext } from './notifications/sample-context';

import './notifications-view.css';

/**
 * Benachrichtigungen of one form — list on the
 * left, editor on the right, and the link „✉ Versandprotokoll" to view 6.
 *
 * **What is server state and what is not.** The notifications, the form and the
 * effective settings all come from TanStack Query; the row being written is a
 * local draft (`notification-draft.ts`). The view never writes the draft back
 * into the cache and never renders the cache as if it were the draft — that
 * split is what makes „Nicht gespeichert" mean something (`CONTRIBUTING.md`).
 *
 * **The questions come from `GET /api/forms/:id`, not from the notification.**
 * A placeholder stores the question **id** and the chip shows the question's
 * caption, so the captions have to be resolved against
 * the form — and the notification wire schema stays `strict` and unextended,
 * which is what keeps a second, stale copy of every caption out of the mail
 * templates.
 */

/** Which row the editor is on. `'new'` is an unsaved notification. */
type Selection =
  { readonly kind: 'new' } | { readonly kind: 'existing'; readonly id: string };

function selectionKey(selection: Selection): string {
  return selection.kind === 'new' ? 'new' : selection.id;
}

export function NotificationsView({
  formId,
  tenantName,
}: {
  readonly formId: string;
  /** Display name of the organisation — what `{{formularorganisation}}` shows in the preview. */
  readonly tenantName: string | undefined;
}): ReactElement {
  const form = useForm(formId);
  const notifications = useNotifications(formId);
  /**
   * What the editor may start from — an installation-wide setting
   * , delivered with the list above and therefore free of a
   * second request. Not a constant any more: the superadmin edits these texts.
   */
  const templates = useNotificationTemplates(formId);
  /**
   * Organisation and system level of the reply-to address (the requirement) — out of the same
   * answer as the rows and the templates, see `useInheritedReplyTo`.
   */
  const inheritedReplyTo = useInheritedReplyTo(formId);
  const create = useCreateNotification();
  const update = useUpdateNotification();
  const remove = useDeleteNotification();

  const [selection, setSelection] = useState<Selection | null>(null);
  /**
   * The unsaved edits, tagged with the row they belong to.
   *
   * Refilled when the selection changes and **never** from a background
   * refetch: a refetch that replaced the draft would throw away everything
   * typed since the editor opened — the loss the requirement exists to prevent,
   * and `SettingsView` guards the same way.
   */
  const [state, setState] = useState<{
    readonly key: string;
    readonly draft: NotificationDraft;
  } | null>(null);

  const rows = notifications.data;

  // Opens the first notification once the list is there, so the view is not an
  // empty right-hand pane on a form that already has notifications.
  useEffect(() => {
    if (selection === null && rows !== undefined && rows.length > 0) {
      const first = rows[0];
      if (first !== undefined) {
        setSelection({ kind: 'existing', id: first.id });
      }
    }
  }, [rows, selection]);

  const selected: Notification | null =
    selection?.kind === 'existing'
      ? (rows?.find((row) => row.id === selection.id) ?? null)
      : null;

  useEffect(() => {
    if (selection === null) {
      return;
    }
    const key = selectionKey(selection);
    setState((current) => {
      if (current?.key === key) {
        return current;
      }
      if (selection.kind === 'new') {
        return { key, draft: emptyDraft() };
      }
      const row = rows?.find((candidate) => candidate.id === selection.id);
      return row === undefined ? null : { key, draft: draftOf(row) };
    });
  }, [selection, rows]);

  if (form.isPending || notifications.isPending) {
    return (
      <div className="notifications">
        <p className="notifications__state" role="status">
          Benachrichtigungen werden geladen…
        </p>
      </div>
    );
  }

  if (notifications.data === undefined || form.data === undefined) {
    const status =
      notifications.error instanceof ApiError
        ? notifications.error.status
        : form.error instanceof ApiError
          ? form.error.status
          : undefined;
    return (
      <div className="notifications">
        <p className="notifications__state" role="alert">
          {status === 403
            ? 'Diese Rolle darf die Benachrichtigungen dieses Formulars nicht sehen.'
            : status === 404
              ? 'Dieses Formular gibt es nicht (mehr).'
              : 'Die Benachrichtigungen konnten nicht geladen werden.'}{' '}
          <button
            type="button"
            className="notifications__link"
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

  const definition = form.data.definition;
  const questions = allQuestions(definition);
  const addressQuestions = addressQuestionsOf(questions);

  const activeKey = selection === null ? null : selectionKey(selection);
  const draft =
    state !== null && activeKey !== null && state.key === activeKey
      ? state.draft
      : null;

  const context = sampleContext({
    definition,
    formularorganisation: tenantName ?? 'Organisation',
    formular: form.data.title,
  });

  const problems =
    draft === null
      ? []
      : draftProblems(draft, {
          hasAddressQuestion: addressQuestions.length > 0,
          questions,
        });

  const onSave = (): void => {
    if (draft === null || selection === null) {
      return;
    }
    const input = toWriteRequest(draft);

    if (selection.kind === 'new') {
      create.mutate(
        { formId, input },
        {
          // The created row is what the editor continues on: selecting it by id
          // is what turns „Neu" into an existing notification without a second
          // round trip, and without leaving a second „Neu" behind.
          onSuccess: (created) => {
            setSelection({ kind: 'existing', id: created.id });
            setState({ key: created.id, draft: draftOf(created) });
          },
        },
      );
      return;
    }

    update.mutate(
      { formId, notificationId: selection.id, input },
      {
        onSuccess: (saved) => {
          setState({ key: saved.id, draft: draftOf(saved) });
        },
      },
    );
  };

  const onDelete = (): void => {
    if (selection?.kind !== 'existing') {
      return;
    }
    remove.mutate(
      { formId, notificationId: selection.id },
      {
        onSuccess: () => {
          setSelection(null);
          setState(null);
        },
      },
    );
  };

  const saveError = writeErrorMessage(
    create.error ?? update.error ?? remove.error,
  );

  return (
    <div className="notifications">
      <div className="notifications__head">
        <h1 className="notifications__title">
          Benachrichtigungen ·{' '}
          <span className="notifications__title-form">{form.data.title}</span>
        </h1>
        <div className="notifications__head-actions">
          <button
            type="button"
            className="notifications__button"
            onClick={() => {
              navigate(builderPath(formId));
            }}
          >
            Zum Builder
          </button>
          <button
            type="button"
            className="notifications__button"
            onClick={() => {
              navigate(mailLogPath(formId));
            }}
          >
            <span aria-hidden="true">✉ </span>Versandprotokoll
          </button>
        </div>
      </div>

      <p className="notifications__lead">
        E-Mails, die beim Absenden dieses Formulars verschickt werden. Eine
        Benachrichtigung an die ausfüllende Person geht raus, sobald sie hier
        aktiv ist – wer keine möchte, pausiert oder löscht sie.
      </p>

      <div className="notifications__layout">
        <div className="notifications__list-pane">
          <button
            type="button"
            className="notifications__new"
            onClick={() => {
              setSelection({ kind: 'new' });
              setState({ key: 'new', draft: emptyDraft() });
            }}
          >
            + Neue Benachrichtigung
          </button>

          {rows === undefined || rows.length === 0 ? (
            <p className="notifications__empty">
              Noch keine Benachrichtigung. Ohne eine solche verschickt dieses
              Formular keine E-Mail.
            </p>
          ) : (
            <ul className="notifications__list">
              {rows.map((row) => {
                const current =
                  selection?.kind === 'existing' && selection.id === row.id;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={
                        current
                          ? 'notifications__item notifications__item--current'
                          : 'notifications__item'
                      }
                      aria-current={current ? 'true' : undefined}
                      onClick={() => {
                        setSelection({ kind: 'existing', id: row.id });
                      }}
                    >
                      <span className="notifications__item-name">
                        {row.name}
                      </span>
                      <span className="notifications__item-meta">
                        {row.toSubmitter
                          ? 'An die ausfüllende Person'
                          : 'Intern'}
                        {row.active ? '' : ' · Pausiert'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {selection?.kind === 'new' ? (
            <p className="notifications__empty">
              Neue Benachrichtigung – noch nicht gespeichert.
            </p>
          ) : null}
        </div>

        {draft === null ? (
          <p className="notifications__placeholder">
            Links eine Benachrichtigung wählen oder eine neue anlegen.
          </p>
        ) : (
          <NotificationEditor
            draft={draft}
            onChange={(patch) => {
              setState({
                key: activeKey ?? 'new',
                draft: { ...draft, ...patch },
              });
            }}
            questions={questions}
            addressQuestions={addressQuestions}
            templates={templates.data ?? []}
            context={context}
            problems={problems}
            saveError={saveError}
            isSaving={create.isPending || update.isPending}
            isDeleting={remove.isPending}
            isDirty={isDraftDirty(selected, draft)}
            onDelete={selection?.kind === 'existing' ? onDelete : null}
            onSave={onSave}
            /*
             * The two **inherited** levels, from the server (the requirement) —
             * the same for every notification of this form, therefore
             * once on the list and not per row. The editor puts the
             * draft value in front and evaluates with the shared function;
             * `selected.effectiveReplyTo` is the server's answer for the
             * **saved** row and therefore does not answer the editor's
             * question (and for „Neu" it does not exist at all).
             *
             * `[]` only while the list is loading — this view then renders
             * its loading state anyway; the chain would yield „keine", which
             * asserts nothing false for half a moment.
             */
            inheritedReplyTo={inheritedReplyTo.data ?? []}
          />
        )}
      </div>
    </div>
  );
}

/** The server's sentence behind a failed write, or a general one. */
function writeErrorMessage(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Diese Rolle darf die Benachrichtigungen dieses Formulars nicht ändern.';
    }
    // The 422s of `NotificationsService` are sentences written for this screen
    // („Das Formular hat keine E-Mail-Frage …"); showing the server's own text
    // beats a second wording that can drift away from it.
    if (error.detail !== undefined) {
      return error.detail;
    }
  }
  return 'Speichern fehlgeschlagen. Bitte erneut versuchen.';
}
