import type { ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  FormTemplateSummary,
  SaveFormTemplateRequest,
  UpdateFormTemplateContentRequest,
} from '@formsache/shared';
import type { PublishPreview } from '@formsache/shared';

import {
  useDeleteFormTemplate,
  useFormTemplates,
  useInsertFormTemplate,
  useRenameFormTemplate,
  useSaveFormTemplate,
  useUpdateFormTemplateContent,
} from '../api/form-templates';
import {
  isNothingToPublish,
  isStaleRevision,
  useCreateForm,
  useForm,
  usePublishForm,
  usePublishPreview,
  useSaveForm,
} from '../api/forms';
import { ApiError } from '../api/http';
import {
  activePage,
  currentDefinition,
  selectedQuestion,
  useBuilderStore,
} from '../builder/builder-store';
import { DraftGuardDialog } from '../builder/DraftGuardDialog';
import { PageList } from '../builder/PageList';
import { QuestionCanvas } from '../builder/QuestionCanvas';
import { QuestionProperties } from '../builder/QuestionProperties';
import { TypePalette } from '../builder/TypePalette';
import { useDraftGuard } from '../builder/use-draft-guard';
import { useIsDesktop } from '../hooks/use-is-desktop';
import { useFocusTrap } from '../shell/use-focus-trap';
import { DASHBOARD_PATH, builderPath, publicFormPath } from '../router/routes';
import { navigate } from '../router/use-route';
import { BuilderSheet } from './builder/BuilderSheet';
import { PublishNotice } from './builder/PublishNotice';
import { useOpenLegalPageNames } from './builder/use-open-legal-page-names';
import { TemplateDrawer } from './builder/TemplateDrawer';
import {
  TemplateSavePrompt,
  type TemplateSaveKind,
} from './builder/TemplateSavePrompt';

import './builder-view.css';

/**
 * Feedback state of the "Kopieren" button next to the public address.
 *
 * `'failed'` exists because `navigator.clipboard` is not a given — an
 * insecure context (plain HTTP) or an older browser has no such API, and
 * `writeText` itself can reject even where it exists (permission denied).
 * A button that looks like it copied when it did not is worse than none, so
 * the failure gets its own visible — and audible, via `role="status"` —
 * message instead of failing silently.
 */
type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Writes to the clipboard, tolerating every way that can fail.
 *
 * Never rejects: the caller only ever needs to know whether it worked. The
 * try/catch alone covers `navigator.clipboard` being absent too — an
 * insecure context or an older browser leaves it `undefined` at runtime even
 * though the DOM types call it non-optional, and reading `.writeText` off
 * `undefined` throws synchronously, landing in the same `catch`.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the „Erneut veröffentlichen" press currently stands.
 *
 * - `idle` — nothing pending.
 * - `checking` — the preview is on its way; the button is busy, and no dialog
 *   has appeared yet. Deliberately *not* an empty dialog that fills in a moment
 *   later: the usual case (no answers, or nothing changed) never opens one at
 *   all, and a modal that flashes open and closes again is worse than a button
 *   that stays pressed for a moment.
 * - `confirm` — the notice is up, with what the server reported.
 * - `unavailable` — the preview could not be fetched. The notice still appears,
 *   saying so: „ich weiß nicht, was sich ändert" is a thing the editor has to
 *   be told, and quietly publishing instead would be exactly the accident
 *   Konzept no. 23 is about.
 */
type PublishStep = 'idle' | 'checking' | 'confirm' | 'unavailable';

/**
 * Whether this publish is worth stopping for (Konzept no. 23).
 *
 * **`blocked` stops it on its own**, before the two
 * conditions below are even asked. A notification still pointing at a question
 * the new version drops — or a bedingte Anzeige whose source the new version
 * drops, retypes or moves behind it — makes the server refuse the publish with a
 * 422, so „nothing worth stopping for" would mean pressing a button that cannot
 * work and reading the reason afterwards. The whole point of the decision is
 * that the lock is stated *before* the press — and unlike everything else in
 * this notice, this part is not advice the editor may overrule.
 *
 * **The first publication is not covered, deliberately and unchanged**: below,
 * `form.status !== 'active'` publishes without asking for a preview at all, so a
 * never-published form still meets the condition lock as the 422 it always was
 * (measured by `e2e/conditional-logic.spec.ts` (b)). Both locks have that same
 * edge, and 0.2 is about the *republish* dialog the placeholder finding already
 * sits in.
 *
 * The other two conditions, both of them necessary:
 *
 * - **There are answers.** Without a single answer on file nothing can be lost
 *   by republishing — a removed question leaves no orphaned column behind, a
 *   changed type strands no data. The decision names what the notice is for
 *   („Es liegen bereits N Antworten vor"), and with N = 0 there is nothing to
 *   say. A diff would still be *interesting*, but a modal nobody needs is
 *   friction that teaches editors to click it away unread — which would cost
 *   exactly the attention the notice is meant to buy for the case that matters.
 * - **Something about the questions changed.** Republishing after a typo in the
 *   title or a settings change touches no answer at all; stopping for an empty
 *   list would be the same friction with nothing behind it.
 */
function needsPublishNotice(preview: PublishPreview): boolean {
  if (preview.blocked.length > 0) {
    return true;
  }
  /*
    **The missing legal texts stop the dialog** (ADR-0028).

    That is the point of the notice and not its side effect: it is meant to be
    **seen** before a form goes public, and a notice that only appears when a
    question happened to be removed as well is precisely the one that does not
    appear when it is needed — at the first publication.

    It costs one additional click per publication, **for as long as the texts
    are missing**, and none any more once they are in place. Exactly the kind
    of pressure `docs/legal/README.md` 5.5 suggests instead of a mandatory
    field.
  */
  if (preview.organisationLegal !== 'ready') {
    return true;
  }
  /*
    **And the privacy notice of *this* form** (ADR-0028 no. 4).

    A state of its own beside the organisation's, because it is an obligation
    of its own: purpose and legal basis have to be stated per **processing**
    under Art. 13 Abs. 1 lit. c, and a form is one processing. An organisation
    can have its general notices fully on file and still have said nothing for
    this form.

    It comes out of the preview and not out of a second request — and that is
    the difference that makes it effective: the preview sits behind
    `can_build`, that is, behind the right that publishes. Since ADR-0028 open
    item 3 the organisation's traffic light one line above comes from the same
    place and for the same reason; only *which* page is missing still needs
    `can_manage_settings` (`use-open-legal-page-names.ts`).

    **Expressly not an entry in the list of open points on the dashboard.** An
    organisation whose general declaration suffices for its forms would
    permanently see a message there that names nothing that could be fixed —
    and „eine Zeile, die überall steht, wird überall überlesen" (ADR-0022
    no. 5). The place where the question changes something is the moment
    before the publication, and it stands only there.
  */
  if (preview.privacyNotice !== 'ready') {
    return true;
  }
  const { removed, added, typeChanged } = preview.changes;
  return (
    preview.responseCount > 0 &&
    removed.length + added.length + typeChanged.length > 0
  );
}

/**
 * The form builder.
 *
 * Three columns on desktop — pages, canvas, panel — and two off-canvas sheets
 * below 1180 px. The view owns the *server* conversation (load, save,
 * publish); the document itself lives in the Zustand store, and the two never
 * write into each other.
 */
export function BuilderView({
  formId,
  canBuild,
  canManageTemplates,
  canUpdateTemplates,
}: {
  readonly formId: string;
  /**
   * `can_build` of the active membership (the requirement).
   *
   * Every door into this view is hidden without it, so what arrives here
   * without it came from a bookmark or a link in a mail — and that is exactly
   * the case that used to hurt: the editor was fully operable and `PUT
   * /api/forms/:id` refused the save at the end. „Speichern" and
   * „Veröffentlichen" are therefore gone and the bar **says why**, before any
   * work is done rather than after it.
   *
   * Comfort, not a boundary: the guard behind the route answers 403 whatever
   * this flag says (`CONTRIBUTING.md`).
   */
  readonly canBuild: boolean;
  /**
   * Whether „Endgültig löschen" **and „Umbenennen"** are offered in *Vorlagen &
   * Blöcke* (no. 74).
   *
   * Its own prop and **not** derived from `canBuild` here, because it is a
   * different question: both routes ask for `can_view_responses` **and**
   * `can_build` — the signature this application gives to a write nobody can
   * take back. Deleting is irreversible because there is no
   * trash for a template; renaming is irreversible for everybody *except*
   * whoever pressed it, because nothing records the old name (follow-up to
   * no. 74).
   *
   * **One flag for both**, and that is the honest shape rather than a
   * shortcut: they are the two routes on `/form-templates/:id`, they name no
   * form (`@NoFormIdInRequest`), so no per-form cap speaks about them and the
   * pair is read Organisation-wide by the caller — as `TrashView`'s `canPurge` already
   * is. Two props with one derivation would be two places to drift apart.
   *
   * Comfort, not a boundary — `DELETE`/`PATCH /form-templates/:id` answer 403
   * whatever this flag says (`CONTRIBUTING.md`).
   */
  readonly canManageTemplates: boolean;
  /**
   * Whether „Aus diesem Formular aktualisieren" is offered.
   *
   * The same pair of rights as the physical deletion — it overwrites content for
   * which there is no trash —, **but from a different source**, and that
   * is not a subtlety: this route sits under `forms/:formId`, because it
   * copies the form that is currently open. With that the fourth link of the
   * chain takes effect, and a form restriction can cut the pair on *this*
   * form. The caller therefore reads the rights **of this form**, while
   * `canManageTemplates` beside it reads the organisation-wide ones.
   *
   * Comfort, not a boundary — `PUT /forms/:formId/templates/:id` answers 403
   * (or 404 when access has been withdrawn) whatever this flag says.
   */
  readonly canUpdateTemplates: boolean;
  /**
   * `can_manage_form_settings` — the **effective** right on this form, as the
   * server reported it. The settings entry is hidden without it: the route
   * behind it answers 403 either way, and showing a door that is locked is how
   * a permission gets assumed to exist.
   *
   * The **organisation-wide** `can_manage_settings` it expressly is not
   * (ADR-0021): the button leads to `GET /forms/:id/settings`, and that route
   * has since demanded the right per form. Under the old flag there was no
   * button here for the standard group `editor`, although it would have been
   * let through — and for a group with only the wide right there was one that
   * led into a 403.
   *
   * **This view has not read the right since review finding 18**: the button
   * it opened is gone, because the subheader above it (`FormNav`) offers the
   * same address under the same right — on narrow devices out of the same
   * `formNavEntries()` in the menu. The field stays in this signature because
   * the shell still passes it; striking it here would turn a right that is
   * handed in into a type error in `AppShell`.
   */
  readonly canManageFormSettings: boolean;
}): ReactElement {
  const isDesktop = useIsDesktop();
  const query = useForm(formId);
  const save = useSaveForm();
  const publish = usePublishForm();
  const publishPreview = usePublishPreview(formId);
  /*
    The legal texts of this organisation (ADR-0028) — a notice before going
    public, not a lock. Only its **second** stage, the page names: *that*
    something is missing comes out of the preview and thereby reaches every
    person who may publish. Why the names need a permission of their own is
    written at the hook.
  */
  const openLegalPageNames = useOpenLegalPageNames();
  // Templates. The list is only fetched while the drawer is open — a
  // shelf nobody has looked at yet is not worth a request on every builder
  // load.
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const templates = useFormTemplates(templatesOpen && canBuild);
  const saveTemplate = useSaveFormTemplate();
  const insertTemplate = useInsertFormTemplate();
  const renameTemplate = useRenameFormTemplate();
  const updateTemplate = useUpdateFormTemplateContent();
  const deleteTemplate = useDeleteFormTemplate();
  const createForm = useCreateForm();

  const load = useBuilderStore((state) => state.load);
  const markSaved = useBuilderStore((state) => state.markSaved);
  const title = useBuilderStore((state) => state.title);
  const setTitle = useBuilderStore((state) => state.setTitle);
  const isDirty = useBuilderStore((state) => state.isDirty);
  const revision = useBuilderStore((state) => state.revision);
  const loadedFormId = useBuilderStore((state) => state.formId);
  const selected = useBuilderStore(selectedQuestion);
  const insertTemplatePage = useBuilderStore(
    (state) => state.insertTemplatePage,
  );
  const insertTemplateQuestion = useBuilderStore(
    (state) => state.insertTemplateQuestion,
  );
  const currentPage = useBuilderStore(activePage);

  const [sheet, setSheet] = useState<'pages' | 'panel' | null>(null);
  /**
   * Whether the confirmation before „Änderungen verwerfen" is up (review
   * finding 18).
   *
   * A confirmation and not an immediate discard: the button stands next to
   * „Speichern", it takes away what has been typed since the last save, and
   * there is no undo for that. The same pattern as when leaving the page
   * (`DraftGuardDialog`) — and the same construction, so that the builder's
   * second confirmation does not look different from its first.
   */
  const [discarding, setDiscarding] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [publishStep, setPublishStep] = useState<PublishStep>('idle');

  /**
   * The revision the current publish decision is about.
   *
   * Set when the button is pressed, and again to the revision the preview
   * describes — those differ exactly when somebody else saved in between, and
   * then the notice on screen describes a document this editor has never seen.
   * A ref rather than state: it is read by the handler that follows the press,
   * and it is always written before the `setPublishStep` that re-renders.
   */
  const checkedRevision = useRef(revision);

  /** The publish button, so the notice can hand focus back to it. */
  const publishButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * The „☆ …" press being named, or null.
   *
   * The **kind** is what the press decided; the page or question it is about
   * is read from the store at confirm time, not captured here — the editor may
   * still switch pages while the dialog is open, and the dialog names what it
   * is saving in its heading either way.
   */
  const [templateSave, setTemplateSave] = useState<TemplateSaveKind | null>(
    null,
  );
  /** What the last templates request said went wrong, or null. */
  const [templateError, setTemplateError] = useState<string | null>(null);
  /** The row of the drawer with a request in flight. */
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);
  /** The control the drawer and the prompt hand focus back to. */
  const templatesButtonRef = useRef<HTMLElement>(null);

  const form = query.data;

  /**
   * Loads the document into the store — once per form, and **not** on every
   * refetch.
   *
   * The guard is the whole point: a background refetch that overwrote the
   * store would throw away everything typed since the last save, which is the
   * loss the requirement is about. The store is refilled only when a *different*
   * form is opened.
   */
  useEffect(() => {
    if (form !== undefined && loadedFormId !== form.id) {
      load({
        id: form.id,
        title: form.title,
        definition: form.definition,
        revision: form.revision,
      });
    }
  }, [form, loadedFormId, load]);

  /**
   * The leave dialog — review finding 21a. What it locks and what it does not
   * is in {@link useDraftGuard}.
   */
  const guard = useDraftGuard({ formId, canSave: canBuild });

  /*
   * Up to review finding 21b there was an unconditional `reset` on unmount
   * here, on the grounds that another form would otherwise show the pages of
   * the previous one for the length of one paint. That is exactly what turned
   * the switch to the preview into a silent loss of data: the preview read the
   * server state, the store was empty, and what had been typed since the last
   * save was no longer there.
   *
   * The original purpose is still covered, only in two other places: **nothing
   * is drawn until the store carries this form** (the lock below at
   * `loadedFormId !== form.id`), and a *clean* document does get thrown away
   * on leaving — `useDraftGuard` takes care of that for both views that keep a
   * draft open. A *different* form replaces the document anyway, because
   * `load` resets the store to `initial`.
   */

  // Resizing past the breakpoint removes the sheet triggers; a sheet left open
  // would have no way back.
  useEffect(() => {
    if (isDesktop) {
      setSheet(null);
    }
  }, [isDesktop]);

  /*
    Every publish error describes the document as it stood when the server
    refused it — „nichts zu veröffentlichen" most literally. A mutation error
    outlives that document: the editor reads the refusal, types on, and the
    sentence keeps standing over a draft that now differs, while the state line
    beside it already asks for a save. So the first edit clears it.

    Not guarded on `nothingToPublish` instead, which is the obvious-looking
    fix: in the race this alert exists for, another tab published *this* draft
    a moment ago, so the client's flag still says there are changes. The very
    situation the sentence is about is one in which that guard is false.
  */
  const resetPublish = publish.reset;
  useEffect(() => {
    if (isDirty) {
      resetPublish();
    }
  }, [isDirty, resetPublish]);

  /*
    The dialog belongs in **every** return path: the lock hangs on the store,
    not on the loading state, and an intercepted click without a visible
    confirmation would be a navigation that simply does not happen.
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

  if (query.isPending) {
    return (
      <div className="builder__state" role="status">
        Formular wird geladen…
        {guardDialog}
      </div>
    );
  }

  if (form === undefined) {
    const notFound =
      query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="builder__state" role="alert">
        {notFound
          ? 'Dieses Formular gibt es nicht (mehr).'
          : 'Das Formular konnte nicht geladen werden.'}{' '}
        <button
          type="button"
          className="builder__link"
          onClick={() => {
            navigate(DASHBOARD_PATH);
          }}
        >
          Zurück zum Dashboard
        </button>
        {guardDialog}
      </div>
    );
  }

  /*
    The store does not yet (or no longer) carry this form: the effect above
    fills it in the same pass. Until then the loading state is shown instead of
    an empty canvas — or, when switching forms, the pages of the previous one.
    That is the purpose the earlier `reset` on unmount had; it stands here now,
    where it does not take the unsaved draft along with it.
  */
  if (loadedFormId !== form.id) {
    return (
      <div className="builder__state" role="status">
        Formular wird geladen…
        {guardDialog}
      </div>
    );
  }

  const onSave = (): void => {
    const state = useBuilderStore.getState();
    save.mutate(
      {
        formId,
        request: {
          title: state.title,
          definition: currentDefinition(state),
          revision: state.revision,
        },
      },
      {
        onSuccess: (saved) => {
          markSaved(saved.revision);
        },
      },
    );
  };

  /**
   * „Änderungen verwerfen" — the store gets the last **saved** state back
   * (review finding 18).
   *
   * `form` is exactly that: `useSaveForm` writes the server's answer into the
   * cache of this query (`api/forms.ts`), so after every save it carries what
   * was saved. A second „last state" carried along here would be a second
   * answer to the same question — and the two would diverge precisely when
   * somebody else has saved.
   *
   * `load` resets the store to `initial` and refills it: with that, selection
   * and open page are those of the loaded document again, and `isDirty` is
   * false again.
   */
  const onDiscardChanges = (): void => {
    load({
      id: form.id,
      title: form.title,
      definition: form.definition,
      revision: form.revision,
    });
    setDiscarding(false);
  };

  /**
   * Saves the draft if there is anything to save, and says whether the
   * document on the server is now the one on screen.
   *
   * Every template action goes through it first, and that is not politeness:
   * the server copies what it has **stored** (`FormTemplatesService.save`
   * reads `form.draft_schema`), so saving a template from an unsaved builder
   * would store the document as it was before the last five edits — silently,
   * and with no way to tell afterwards. Creating a form from a template goes
   * through it too, because it navigates away.
   */
  const persistDraft = async (): Promise<boolean> => {
    const state = useBuilderStore.getState();
    if (!state.isDirty) {
      return true;
    }
    try {
      const saved = await save.mutateAsync({
        formId,
        request: {
          title: state.title,
          definition: currentDefinition(state),
          revision: state.revision,
        },
      });
      markSaved(saved.revision);
      return true;
    } catch {
      return false;
    }
  };

  /** „☆ Als Vorlage speichern" — confirmed, with the name the dialog took. */
  const onConfirmTemplateSave = (
    kind: TemplateSaveKind,
    name: string,
  ): void => {
    setTemplateError(null);
    void (async () => {
      if (!(await persistDraft())) {
        setTemplateError(
          'Der Entwurf konnte nicht gespeichert werden. Die Vorlage wurde deshalb nicht angelegt.',
        );
        return;
      }

      const state = useBuilderStore.getState();
      const page = activePage(state);
      const question = selectedQuestion(state);
      const request: SaveFormTemplateRequest | null =
        kind === 'form'
          ? { kind: 'form', name }
          : kind === 'page'
            ? page === undefined
              ? null
              : { kind: 'page', name, pageId: page.id }
            : question === undefined
              ? null
              : { kind: 'question', name, questionId: question.id };
      if (request === null) {
        setTemplateError(
          'Es ist nichts ausgewählt, was gespeichert werden könnte.',
        );
        return;
      }

      saveTemplate.mutate(
        { formId, request },
        {
          onSuccess: () => {
            setTemplateSave(null);
          },
          onError: () => {
            setTemplateError('Die Vorlage konnte nicht gespeichert werden.');
          },
        },
      );
    })();
  };

  /** „Einfügen" / „Als Seite" — the block the server just gave fresh ids. */
  const onInsertTemplate = (template: FormTemplateSummary): void => {
    setBusyTemplateId(template.id);
    insertTemplate.mutate(template.id, {
      onSuccess: (instance) => {
        if (instance.kind === 'page') {
          insertTemplatePage(instance.page);
        } else {
          insertTemplateQuestion(instance.question);
        }
        setTemplatesOpen(false);
      },
      onSettled: () => {
        setBusyTemplateId(null);
      },
    });
  };

  /** „Neues Formular" — a form template becomes a row, and we go there. */
  const onCreateFormFromTemplate = (template: FormTemplateSummary): void => {
    setBusyTemplateId(template.id);
    void (async () => {
      if (!(await persistDraft())) {
        setBusyTemplateId(null);
        return;
      }
      createForm.mutate(
        { title: template.name, templateId: template.id },
        {
          onSuccess: (created) => {
            setTemplatesOpen(false);
            navigate(builderPath(created.id));
          },
          onSettled: () => {
            setBusyTemplateId(null);
          },
        },
      );
    })();
  };

  /** „Umbenennen" — the name alone, without touching the content. */
  const onRenameTemplate = (
    template: FormTemplateSummary,
    name: string,
  ): void => {
    setTemplateError(null);
    setBusyTemplateId(template.id);
    renameTemplate.mutate(
      { templateId: template.id, name },
      {
        onError: () => {
          setTemplateError('Die Vorlage konnte nicht umbenannt werden.');
        },
        onSettled: () => {
          setBusyTemplateId(null);
        },
      },
    );
  };

  /**
   * „Aus diesem Formular aktualisieren" — the content of the template is
   * replaced by that of the open form.
   *
   * `persistDraft` **first**, for exactly the reason the saving names: the
   * server copies what it has stored. Without it „aktualisieren" would write
   * the state before the last five changes into the template — unnoticed, and
   * irreversible, because there is no trash for templates.
   *
   * The kind stays: a page template is refreshed from the open page, a question
   * template from the selected question. The drawer's confirmation announced
   * exactly that, and the server rejects a different kind.
   */
  const onUpdateTemplate = (template: FormTemplateSummary): void => {
    setTemplateError(null);
    void (async () => {
      setBusyTemplateId(template.id);
      if (!(await persistDraft())) {
        setTemplateError(
          'Der Entwurf konnte nicht gespeichert werden. Die Vorlage wurde deshalb nicht geändert.',
        );
        setBusyTemplateId(null);
        return;
      }

      const state = useBuilderStore.getState();
      const page = activePage(state);
      const question = selectedQuestion(state);
      const update: UpdateFormTemplateContentRequest | null =
        template.kind === 'form'
          ? { kind: 'form' }
          : template.kind === 'page'
            ? page === undefined
              ? null
              : { kind: 'page', pageId: page.id }
            : question === undefined
              ? null
              : { kind: 'question', questionId: question.id };
      if (update === null) {
        setTemplateError(
          'Es ist nichts ausgewählt, woraus die Vorlage aktualisiert werden könnte.',
        );
        setBusyTemplateId(null);
        return;
      }

      updateTemplate.mutate(
        { formId, templateId: template.id, request: update },
        {
          onError: () => {
            setTemplateError('Die Vorlage konnte nicht aktualisiert werden.');
          },
          onSettled: () => {
            setBusyTemplateId(null);
          },
        },
      );
    })();
  };

  const onDeleteTemplate = (template: FormTemplateSummary): void => {
    setTemplateError(null);
    setBusyTemplateId(template.id);
    deleteTemplate.mutate(template.id, {
      onError: () => {
        setTemplateError('Die Vorlage konnte nicht gelöscht werden.');
      },
      onSettled: () => {
        setBusyTemplateId(null);
      },
    });
  };

  /**
   * Publishes — **if** the draft is still the one the decision was made about.
   *
   * This is the single place where a publish leaves the client, and therefore
   * the only place the freshness check belongs. It used to sit on the notice's
   * confirm button, which left the other path open: while the preview is in
   * flight the publish *button* is disabled, but the canvas is not — there is
   * no dialog and no scrim yet — so a keystroke during that half second used to
   * publish the stored draft while the bar still read „Nicht gespeichert".
   *
   * `expected` is the revision the decision was taken on. Comparing against it
   * catches both halves at once: what this editor typed (`isDirty`, the rule
   * the button already carries) and what anybody — including this editor's own
   * save — stored in the meantime. The latter matters beyond correctness:
   * publishing with a revision that has moved on answers 409, and the builder
   * would tell the editor that „jemand anderem" changed the form when it was
   * their own save.
   *
   * Returns whether the publish went out, so callers can show the notice
   * instead of doing nothing visible.
   */
  const publishIfUnchanged = (expected: number): boolean => {
    const state = useBuilderStore.getState();
    if (state.isDirty || state.revision !== expected) {
      return false;
    }

    publish.mutate(
      { formId, revision: state.revision },
      {
        onSuccess: (published) => {
          markSaved(published.revision);
        },
        // The notice stays up until the publish has settled, and only then
        // hands focus back to the button — which is disabled while the request
        // runs and could not have taken focus a moment earlier.
        onSettled: () => {
          setPublishStep('idle');
        },
      },
    );
    return true;
  };

  /**
   * „Veröffentlichen" / „Erneut veröffentlichen" — via the notice of
   * Konzept no. 23.
   *
   * The preview is asked for **here**, not in the background: it describes one
   * revision of the draft and counts answers that keep arriving, so the only
   * moment its answer is true is the moment the decision is made.
   */
  const onPublishRequested = (): void => {
    checkedRevision.current = useBuilderStore.getState().revision;

    // A first publication has nothing to warn about: no version is in force to
    // differ from, and no answer exists that a change could reach.
    if (form.status !== 'active') {
      if (!publishIfUnchanged(checkedRevision.current)) {
        setPublishStep('confirm');
      }
      return;
    }

    setPublishStep('checking');
    publishPreview
      .refetch()
      .then((result) => {
        // `result.data` survives a failed refetch (TanStack keeps the last
        // good answer), so the error is what decides — not the presence of
        // data, which would silently show the *previous* press's verdict.
        if (result.isError || result.data === undefined) {
          setPublishStep('unavailable');
          return;
        }

        checkedRevision.current = result.data.revision;
        if (needsPublishNotice(result.data)) {
          setPublishStep('confirm');
          return;
        }

        // Nothing worth stopping for — but the draft may have moved while the
        // preview was in flight, and then the notice is exactly what is owed.
        if (!publishIfUnchanged(checkedRevision.current)) {
          setPublishStep('confirm');
          return;
        }
        setPublishStep('idle');
      })
      .catch(() => {
        setPublishStep('unavailable');
      });
  };

  /**
   * Whether the notice on screen still describes what pressing publish would
   * do.
   *
   * The display side of the very rule `publishIfUnchanged` enforces — it only
   * decides what the notice *says* and whether its confirm button is offered;
   * nothing publishes on the strength of it.
   *
   * Suppressed while the publish is in flight: `markSaved` moves the revision
   * on success, a beat before the notice closes, and the editor must not see
   * „der Entwurf hat sich geändert" flash across the publish they just
   * confirmed.
   */
  const noticeIsOutdated =
    !publish.isPending && (isDirty || revision !== checkedRevision.current);

  const saveState = isDirty
    ? 'Nicht gespeichert'
    : save.isPending
      ? 'Wird gespeichert…'
      : 'Gespeichert';

  /**
   * Nothing left to publish: the **saved** draft is already the version in
   * force (Konzept no. 29).
   *
   * `hasUnpublishedChanges` is the server's verdict about the *stored*
   * document, so it says nothing about what has been typed since — hence the
   * `isDirty` guard. Without it the button would read „Fassung 3 ist aktuell"
   * over a canvas full of unsaved work, which is the one sentence that must
   * never appear there.
   */
  const nothingToPublish = !isDirty && !form.hasUnpublishedChanges;

  /**
   * What the publish control's live region says — and **which of the two
   * reasons** a locked button is locked for.
   *
   * The two must not collapse into one sentence. `isDirty` locks the button
   * meaning „bitte erst speichern"; `nothingToPublish` locks it meaning
   * „es ist schon draußen". Labelling both the same would send an editor with
   * unsaved changes away as if they were done.
   *
   * A stale success message is ruled out by order: the moment anything is
   * unsaved or unpublished, „Fassung N veröffentlicht" stops being true and one
   * of the earlier branches takes over. Both texts read `form.publishedVersion`
   * — the one number the server just set — so they can never name different
   * versions.
   */
  const publishState: string | null = publish.isPending
    ? 'Wird veröffentlicht…'
    : isDirty
      ? 'Erst speichern, dann veröffentlichen'
      : form.hasUnpublishedChanges
        ? null
        : publish.isSuccess
          ? `Fassung ${String(form.publishedVersion)} veröffentlicht`
          : `Fassung ${String(form.publishedVersion)} ist aktuell`;

  // The full, absolute address — the one worth copying into a round-mail to a
  // whole organisation. `publicFormPath()` alone is a site-relative path and useless
  // outside the app it was copied from.
  const publicUrl = `${window.location.origin}${publicFormPath(form.publicSlug)}`;

  /**
   * What the naming dialog starts with — the caption of the thing being saved.
   *
   * Not „Vorlage 3": a name is what makes the drawer usable at all, and the
   * best guess at it is already on screen.
   */
  const defaultTemplateName = (kind: TemplateSaveKind): string => {
    switch (kind) {
      case 'form':
        return title;
      case 'page':
        return currentPage?.title ?? 'Seite';
      case 'question':
        return selected?.label ?? 'Frage';
    }
  };

  /**
   * The three template controls handed to `PageList` — **only with
   * `canBuild`**, so a reader without it gets no buttons rather than disabled
   * ones. Spread as one object because the list is rendered twice (desktop
   * column and mobile sheet) and two copies of the same three props are two
   * places for them to drift apart.
   */
  const templateControls = canBuild
    ? {
        onOpenTemplates: () => {
          // An error from the last „☆ Speichern" does not belong in a
          // freshly opened drawer — it would stand there above an action that
          // did not cause it.
          setTemplateError(null);
          setTemplatesOpen(true);
        },
        onSaveFormAsTemplate: () => {
          setTemplateError(null);
          setTemplateSave('form');
        },
        onSavePageAsTemplate: () => {
          setTemplateError(null);
          setTemplateSave('page');
        },
      }
    : {};

  const onCopyPublicLink = (): void => {
    writeToClipboard(publicUrl)
      .then((success) => {
        setCopyState(success ? 'copied' : 'failed');
      })
      .catch(() => {
        setCopyState('failed');
      });
  };

  return (
    <div className={isDesktop ? 'builder' : 'builder builder--compact'}>
      <div className="builder__bar">
        {/*
          The form name is the *heading* of the document being worked on — the
          `<h1>` every other view has and the builder was missing — not a field
          on a form. Its accessible name therefore comes from the field's
          value: cleared mid-rename the heading is momentarily nameless, which
          is the honest reading of a document that has no name right now.

          The wrapper mirrors the value so the field is exactly as wide as its
          text; the mechanics are in `.builder__title-sizer`, and `size={1}` is
          part of them, not cosmetics — it removes the input's own default
          width so the mirror can make the box *smaller* as well as larger. The
          placeholder is mirrored while the name is empty, so the box does not
          collapse to nothing mid-rename.
        */}
        <h1 className="builder__heading">
          <span
            className="builder__title-sizer"
            data-value={title === '' ? 'Formularname' : title}
          >
            <input
              className="builder__title"
              size={1}
              value={title}
              aria-label="Formularname"
              placeholder="Formularname"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </span>
        </h1>

        <span
          className={
            isDirty
              ? 'builder__save-state builder__save-state--dirty'
              : 'builder__save-state'
          }
          role="status"
        >
          {saveState}
        </span>

        <div className="builder__actions">
          {isDesktop ? null : (
            <>
              <button
                type="button"
                className="builder__sheet-trigger"
                aria-expanded={sheet === 'pages'}
                onClick={() => {
                  setSheet(sheet === 'pages' ? null : 'pages');
                }}
              >
                Seiten
              </button>
              <button
                type="button"
                className="builder__sheet-trigger"
                aria-expanded={sheet === 'panel'}
                onClick={() => {
                  setSheet(sheet === 'panel' ? null : 'panel');
                }}
              >
                Eigenschaften
              </button>
            </>
          )}

          {/*
            „⚙ Einstellungen" stood here (review finding 18). The way has
            stayed and lies one line higher: the form subheader
            (`shell/FormNav.tsx`) carries „⚙ Formular-Einstellungen" under
            **the same** right `can_manage_form_settings`, and on narrow
            devices `MobileMenuSheet` builds its list out of the same
            `formNavEntries()`. Two buttons for one address, one of them in the
            bar in which one saves and publishes.
          */}
          {canBuild ? (
            <>
              {/*
                „Änderungen verwerfen" (review finding 18) — to the left of
                „Speichern", because it is the answer that keeps nothing, and
                only usable as long as there is something to discard. Without
                changes it is off and says on hover why.
              */}
              <button
                type="button"
                className="builder__discard"
                disabled={save.isPending || !isDirty}
                title={
                  isDirty
                    ? undefined
                    : 'Es gibt keine ungespeicherten Änderungen.'
                }
                onClick={() => {
                  setDiscarding(true);
                }}
              >
                Änderungen verwerfen
              </button>

              <button
                type="button"
                className="builder__save"
                disabled={save.isPending || !isDirty}
                onClick={onSave}
              >
                Speichern
              </button>

              <button
                type="button"
                className="builder__publish"
                ref={publishButtonRef}
                // Publishing an unsaved draft would publish the *stored* one, which
                // is not what the editor is looking at. `checking` keeps a second
                // press from starting a second publish while the first press's
                // preview is still in flight. `nothingToPublish` is the client
                // decision of 2026-07-27: without a change there is no version to
                // mint, and the server refuses it anyway (422).
                disabled={
                  publish.isPending ||
                  isDirty ||
                  publishStep === 'checking' ||
                  nothingToPublish
                }
                // Every reason the button is unavailable says so on hover — an
                // unexplained dead control on a slow connection looks like a click
                // that never arrived. Hover alone would not be enough for the two
                // *lasting* reasons, which is what the live region below is for.
                title={
                  isDirty
                    ? 'Bitte zuerst speichern.'
                    : publishStep === 'checking'
                      ? 'Die Auswirkungen werden geprüft…'
                      : publish.isPending
                        ? 'Wird veröffentlicht…'
                        : nothingToPublish
                          ? 'Es gibt keine Änderungen gegenüber der veröffentlichten Fassung.'
                          : undefined
                }
                onClick={onPublishRequested}
              >
                {form.status === 'active'
                  ? 'Erneut veröffentlichen'
                  : 'Veröffentlichen'}
              </button>
            </>
          ) : null}
        </div>

        {/*
          The counterpart to the save label, and for the same reason: publishing
          is the most consequential thing in this bar and used to say nothing at
          all — the rising version number was the only sign it had happened.

          Rendered **always**, empty when there is nothing to say: a
          `role="status"` element that only appears together with its text is
          frequently not announced at all, because the live region is new to the
          accessibility tree at the moment the text arrives.
        */}
        <span className="builder__publish-state" role="status">
          {publishState}
        </span>
      </div>

      {/*
        Said **before** the work, not after it. Whoever arrives
        here without `canBuild` came past every hidden door — a bookmark, a link
        in a mail — and would otherwise arrange questions for ten minutes and
        meet a 403 on „Speichern". Explaining rather than hiding is the whole
        point here: with the two buttons gone and nothing said, the bar would
        look like a page that had not finished loading.
      */}
      {canBuild ? null : (
        <p className="builder__readonly" role="status">
          Änderungen an diesem Formular sind der Rolle „Bearbeiten" vorbehalten.
          Der Aufbau lässt sich hier ansehen, Speichern und Veröffentlichen
          jedoch nicht – Änderungen gingen beim Verlassen der Seite verloren.
        </p>
      )}

      {isStaleRevision(save.error) || isStaleRevision(publish.error) ? (
        <p className="builder__alert" role="alert">
          Das Formular wurde zwischenzeitlich von jemand anderem geändert. Bitte
          neu laden – sonst gingen die Änderungen der anderen Person verloren.
        </p>
      ) : isNothingToPublish(publish.error) ? (
        /*
          The race the locked button cannot cover: another tab published this
          very draft a moment ago. Telling the editor to reload — which is what
          the branch above says — would be wrong advice about a form that is
          already up to date. It stops being true the moment the editor changes
          anything, and the effect above drops it then.
        */
        <p className="builder__alert" role="alert">
          {/*
            **The endpoint has two 422s since the requirement**, and the status
            alone no longer tells them apart: „nichts zu veröffentlichen" and
            „diese Benachrichtigung verweist auf eine Frage, die fehlt" ask for
            completely different reactions. So the server's own sentence wins
            when it wrote one, and the wording below is what is left for a
            refusal without a readable body — which is the only case the status
            on its own can still describe.

            Not a message *match*: nothing here compares German text to decide
            anything, it only prefers a sentence over a guess.
          */}
          {publish.error instanceof ApiError &&
          publish.error.detail !== undefined
            ? publish.error.detail
            : 'Es gibt nichts zu veröffentlichen – der Entwurf entspricht bereits der veröffentlichten Fassung.'}
        </p>
      ) : save.isError ? (
        <p className="builder__alert" role="alert">
          Speichern fehlgeschlagen. Bitte erneut versuchen.
        </p>
      ) : publish.isError ? (
        /*
          Its own sentence. „Veröffentlichen gibt keine sichtbare Rückmeldung"
          was the second of the two reports this work item answers, and naming
          the failed publish „Speichern fehlgeschlagen" would have left it with
          the wrong one.
        */
        <p className="builder__alert" role="alert">
          Veröffentlichen fehlgeschlagen. Bitte erneut versuchen.
        </p>
      ) : null}

      {form.status === 'active' ? (
        /*
          One strip, not three boxes stacked on top of each other. The address
          is what this area exists for, so it is the only thing in it that
          carries weight; the state travels beside it as the same small badge
          the dashboard card uses, and „Kopieren" is a quiet text button rather
          than a second bordered control competing with it.
        */
        <div className="builder__published">
          <span className="builder__published-status">
            Veröffentlicht (Fassung {String(form.publishedVersion ?? 1)})
          </span>

          {/*
            A real anchor, not a button with `navigate()`: this is the address
            an editor copies into an e-mail to a whole organisation, so „Link in neuem
            Tab öffnen" and „Linkadresse kopieren" have to work — and they only
            exist on an `<a href>`. `target="_blank"` because the builder has
            unsaved-work state a participant view would replace. The href is
            the absolute URL (not just `publicFormPath()`) so both the display
            text and the browser's own "copy link address" agree on the same,
            mail-ready address.
          */}
          <a
            className="builder__slug"
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
          >
            {publicUrl}
          </a>

          <button
            type="button"
            className="builder__copy"
            onClick={onCopyPublicLink}
          >
            {copyState === 'copied' ? 'Kopiert' : 'Kopieren'}
          </button>

          {/*
            `role="status"` so the outcome reaches screen-reader users too —
            the button's own label change ("Kopieren" → "Kopiert") is not
            announced on its own, and the failure case would otherwise be
            silent for everyone.
          */}
          <span
            className={
              copyState === 'failed'
                ? 'builder__copy-feedback builder__copy-feedback--error'
                : 'builder__copy-feedback'
            }
            role="status"
          >
            {copyState === 'copied'
              ? 'Adresse in die Zwischenablage kopiert.'
              : copyState === 'failed'
                ? 'Kopieren war nicht möglich – bitte die Adresse markieren und manuell kopieren.'
                : null}
          </span>
        </div>
      ) : null}

      <div className="builder__columns">
        {isDesktop ? (
          <aside className="builder__pages">
            <PageList {...templateControls} />
          </aside>
        ) : null}

        <QuestionCanvas />

        {isDesktop ? (
          <aside className="builder__panel">
            {selected === undefined ? (
              <TypePalette />
            ) : (
              <QuestionProperties
                question={selected}
                {...(canBuild
                  ? {
                      onSaveAsTemplate: () => {
                        setTemplateError(null);
                        setTemplateSave('question');
                      },
                    }
                  : {})}
              />
            )}
          </aside>
        ) : null}
      </div>

      {!isDesktop && sheet !== null ? (
        <BuilderSheet
          kind={sheet}
          onClose={() => {
            setSheet(null);
          }}
        >
          {sheet === 'pages' ? (
            <PageList {...templateControls} />
          ) : selected === undefined ? (
            <TypePalette />
          ) : (
            <QuestionProperties
              question={selected}
              {...(canBuild
                ? {
                    onSaveAsTemplate: () => {
                      setTemplateError(null);
                      setTemplateSave('question');
                    },
                  }
                : {})}
            />
          )}
        </BuilderSheet>
      ) : null}

      {templatesOpen ? (
        <TemplateDrawer
          templates={templates.data ?? []}
          isPending={templates.isPending}
          isError={templates.isError}
          busyTemplateId={busyTemplateId}
          openerRef={templatesButtonRef}
          onClose={() => {
            setTemplatesOpen(false);
          }}
          error={templateError}
          onInsert={onInsertTemplate}
          onCreateForm={onCreateFormFromTemplate}
          /*
            What „aktualisieren" would copy from — the same two selectors
            `onUpdateTemplate` below reads. The confirmation thereby names the
            page or the question by name; with the wrong active page the old
            content is otherwise gone without anybody having been able to see
            it.
          */
          updateSource={{
            pageTitle: currentPage?.title ?? null,
            questionLabel: selected?.label ?? null,
          }}
          {...(canManageTemplates
            ? // Renaming asks nothing, but demands the same pair as the
              // deletion beside it (follow-up to Konzept no. 74): the name is
              // the only thing by which a template is recognisable.
              { onRename: onRenameTemplate }
            : {})}
          {...(canUpdateTemplates
            ? // The pair, cut down to this form — see the prop.
              { onUpdate: onUpdateTemplate }
            : {})}
          {...(canManageTemplates
            ? // Without the right **no** button, not a greyed-out one
              // — the same construction as `templateControls` above.
              { onDelete: onDeleteTemplate }
            : {})}
        />
      ) : null}

      {templateSave === null ? null : (
        <TemplateSavePrompt
          kind={templateSave}
          defaultName={defaultTemplateName(templateSave)}
          busy={saveTemplate.isPending || save.isPending}
          error={templateError}
          openerRef={templatesButtonRef}
          onCancel={() => {
            setTemplateSave(null);
          }}
          onConfirm={(name) => {
            onConfirmTemplateSave(templateSave, name);
          }}
        />
      )}

      {publishStep === 'confirm' || publishStep === 'unavailable' ? (
        <PublishNotice
          /* `publishPreview.data` outlives a failed refetch, so the step —
             not the presence of data — decides whether a list is shown. */
          preview={publishStep === 'confirm' ? publishPreview.data : undefined}
          outdated={noticeIsOutdated}
          busy={publish.isPending}
          openerRef={publishButtonRef}
          openLegalPageNames={openLegalPageNames}
          onCancel={() => {
            setPublishStep('idle');
          }}
          onConfirm={() => {
            publishIfUnchanged(checkedRevision.current);
          }}
        />
      ) : null}

      {discarding ? (
        <DiscardChangesDialog
          onCancel={() => {
            setDiscarding(false);
          }}
          onConfirm={onDiscardChanges}
        />
      ) : null}

      {guardDialog}
    </div>
  );
}

/**
 * The confirmation before „Änderungen verwerfen" (review finding 18).
 *
 * **The same construction as `DraftGuardDialog`** — scrim, panel with
 * `role="dialog"`, the same focus trap (`useFocusTrap`), the same classes —
 * and expressly not a second dialog system. What differs is the question:
 * there somebody is leaving and still has changes, here somebody stays and
 * wants to be rid of them. Hence two answers instead of three — „Speichern"
 * would here be the opposite of what was asked.
 *
 * Escape and the click beside the dialog are „Abbrechen": the harmless
 * answer, and the only one that one may be able to trigger by accident.
 */
function DiscardChangesDialog({
  onCancel,
  onConfirm,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  const titleId = useId();
  const bodyId = useId();
  const { panelRef, onKeyDown } = useFocusTrap({ onClose: onCancel });

  return (
    <div className="draft-guard">
      <div
        className="draft-guard__scrim"
        aria-hidden="true"
        onClick={onCancel}
      />
      <div
        className="draft-guard__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="draft-guard__title" id={titleId}>
          Änderungen verwerfen
        </h2>

        <p className="draft-guard__body" id={bodyId}>
          Alles, was seit dem letzten Speichern geändert wurde, geht verloren.
          Das Formular steht danach wieder auf dem zuletzt gespeicherten Stand.
        </p>

        <div className="draft-guard__actions">
          <button
            type="button"
            className="draft-guard__cancel"
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="draft-guard__discard"
            onClick={onConfirm}
          >
            Verwerfen
          </button>
        </div>
      </div>
    </div>
  );
}
