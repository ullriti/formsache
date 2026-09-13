import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { FormSummary, Permissions } from '@formsache/shared';
import {
  FORM_PAGE_SIZE_DEFAULT,
  TRASH_RETENTION_DAYS,
} from '@formsache/shared';

import { useFormTemplates } from '../api/form-templates';
import { useCreateForm, useDuplicateForm, useFormPage } from '../api/forms';
import { useDeleteForm } from '../api/trash';
import { builderPath, responsesPath } from '../router/routes';
import { navigate } from '../router/use-route';
import {
  actionErrorMessage,
  FORM_DUPLICATE_SUBJECT,
  TRASH_DELETE_FORM_SUBJECT,
} from './api-messages';
import { ConfirmPrompt } from './tenant-admin/ConfirmPrompt';
import { TenantOpenItems } from './tenant-setup/TenantOpenItems';

import './dashboard-view.css';

export interface DashboardViewProps {
  /** Name of the active tenant, or `undefined` when none is scoped. */
  readonly tenantName?: string | undefined;
  /** Number of tenants the signed-in person may work in. */
  readonly tenantCount: number;
  /**
   * `can_build` of the **active** membership, as the server reported it
   * (the requirement) — never a locally remembered or widest-held right:
   * the same person may build in one organisation and not in the next.
   *
   * This is display, not enforcement. `POST /api/forms` and `PUT /api/forms/:id`
   * require the right regardless of what this page shows (`CONTRIBUTING.md`); the
   * flag only keeps the page from promising what the guard then refuses.
   */
  readonly canBuild: boolean;
  /**
   * Whether this installation has AI form generation at all
   * (ADR-0015 no. 9) — the second part of the condition under which „✦ KI-Formular"
   * stands next to „+ Neues Formular" (finding 18).
   *
   * **Absent, not greyed out**, and the difference is the whole point:
   * a grey button says „das gibt es, du darfst nur gerade nicht", and that
   * is wrong — without a key the route answers 404, and the honest
   * depiction of „gibt es hier nicht" is nothing at all.
   *
   * It is no permission: it says whether the feature exists; `canBuild` says
   * whether this person may use it, and the button needs both. The route
   * asks its own guard chain independently of that (`CONTRIBUTING.md`).
   */
  readonly aiFormsAvailable: boolean;
  /** Opens the AI dialogue. Called only by the button secured above. */
  readonly onOpenAiForm: () => void;
  /**
   * The active Organisation — **only** for the setup notice at the top
   * (ADR-0025), not for the form list: the routes behind it resolve the
   * Organisation from the session themselves and take no id.
   *
   * `undefined` when none is chosen; then nothing stands there.
   */
  readonly tenantId?: string | undefined;
  /**
   * The rights of this person **in this Organisation**, for the same
   * notice: with them it decides which documents it reads at all.
   * Display, no boundary — the guards of the routes go on deciding themselves
   * (`CONTRIBUTING.md`).
   */
  readonly permissions?: Permissions | undefined;
}

/**
 * How long the search field stays quiet before the term becomes a request.
 *
 * Short enough that the grid feels like it follows typing, long enough that
 * „Jahrestagung" is one request rather than eleven. It is a *delay*, not a
 * threshold: the term is always sent eventually, so nothing depends on the
 * reader stopping.
 */
const SEARCH_DEBOUNCE_MS = 200;

/** „N Treffer für „…"" — singular and plural, in one place. */
function countedHits(total: number, term: string): string {
  return total === 1
    ? `1 Treffer für „${term}"`
    : `${String(total)} Treffer für „${term}"`;
}

interface Kpi {
  readonly label: string;
  readonly value: number;
  /** Token name for the figure's colour, following the handoff's accents. */
  readonly tone?: 'success' | 'accent';
}

/**
 * Dashboard (handoff §Screens/Views 1).
 *
 * The form grid is real: the cards come from
 * `GET /api/forms`, the figures are counted from them, and „+ Neues Formular"
 * creates one and opens the builder on it.
 *
 * **It renders a page, not an Organisation.**
 * Two things follow, and both are the requirement rather than polish:
 *
 * 1. **The handoff's search bar arrives here — and it acts on the
 *    server.** It was deliberately left out until now (the old comment here
 *    said so: „filtering belongs with the responses table"), and that
 *    reasoning does not survive a paged list. The responses table filters rows
 *    it *holds*; this one would filter twenty-four of two thousand and report
 *    „keine Treffer" for everything else — not a narrower answer but a false
 *    one. So the term travels as `?q=` and the server decides.
 * 2. **The figures of the KPI row come from the server**, not from the loaded page:
 *    „Formulare" is `total`, „Aktiv" is `activeTotal`, „Antworten gesamt" is
 *    `responseTotal`. Counting them off `items` would have made every tile a
 *    statement about twenty-four cards under a heading that reads like a
 *    statement about the organisation.
 *
 * The forms query only runs while a tenant is scoped. Without one every
 * tenant-bound request answers 403, and firing it anyway would turn a state
 * the app can explain into an error it cannot.
 */
export function DashboardView({
  tenantName,
  tenantCount,
  canBuild,
  aiFormsAvailable,
  onOpenAiForm,
  tenantId,
  permissions,
}: DashboardViewProps): ReactElement {
  const hasTenant = tenantName !== undefined;
  /**
   * What is typed, and what has been asked for — deliberately two values.
   *
   * A keystroke must not be a request: `searchDraft` follows the field at once
   * so typing stays responsive, and `search` follows it after
   * {@link SEARCH_DEBOUNCE_MS} of quiet. One state for both would put a round
   * trip on every character of „Bestandsmeldung".
   */
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  /** Row offset of the page on screen — `page * limit`, never a page number. */
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const next = searchDraft.trim();
    // ⚠️ **The early return is load-bearing, and it was measured.** Without it
    // the effect also runs on mount and on every unrelated re-render, and each
    // run arms a timer that calls `setOffset(0)` 200 ms later. Pressing
    // „Weiter" inside that window then sent the reader straight back to page
    // one — the pager looked broken at random, which is the worst shape a bug
    // can take. A term that has not changed schedules nothing.
    if (next === search) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setSearch(next);
      // A new term means a new list; keeping the offset would open it on page
      // four of a result that has two.
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [searchDraft, search]);

  const forms = useFormPage(
    { offset, limit: FORM_PAGE_SIZE_DEFAULT, search },
    hasTenant,
  );
  const createForm = useCreateForm();
  const duplicateForm = useDuplicateForm();
  const deleteForm = useDeleteForm();
  /**
   * The templates of the Organisation — **only where creating is allowed here**
   * (review finding 17).
   *
   * `enabled` for the same reason `useFormPage` has it: without an
   * Organisation the route answers 403, and without `canBuild` the box in
   * which the selection would sit is not on the page at all.
   */
  const templates = useFormTemplates(hasTenant && canBuild);
  /**
   * Only the templates of the kind `form`. A page or question template is
   * nothing a *form* comes out of — it is inserted into an existing one in the
   * builder (`POST /form-templates/:id/instance`), and the server
   * refuses the other kind here.
   */
  const formTemplates = (templates.data ?? []).filter(
    (template) => template.kind === 'form',
  );
  const [newTitle, setNewTitle] = useState('');
  /** The chosen template, or `''` for „Ohne Vorlage". */
  const [templateId, setTemplateId] = useState('');
  const [missingTitle, setMissingTitle] = useState(false);
  const titleField = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /**
   * „Seite n von m" — the landing place for a focus the pager is about to drop.
   *
   * Pressing „Weiter" onto the last page disables „Weiter", and a browser blurs
   * a control it disables: focus falls to `<body>` and the next Tab starts at
   * the top of the document. The state line is the one element of the pager
   * that is always there and always says where one is.
   */
  const pagerStateRef = useRef<HTMLParagraphElement>(null);
  /** The card whose „× Löschen" confirmation is open — one at a time. */
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  /** One `useDeleteForm` serves every card — a set, not the mutation's own
   *  `variables`, the same reasoning `TrashView.tsx` spells out in full for
   *  the identical shape. */
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  /** One `useDuplicateForm` serves every card, the same reasoning as above. */
  const [duplicatingIds, setDuplicatingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [duplicateErrors, setDuplicateErrors] = useState<
    Record<string, string>
  >({});

  /**
   * Moves focus to the page's own `<h1>` after a card leaves the grid.
   *
   * The card that carried the pressed button is gone the moment the refetch
   * lands — this is the same „a focus that falls into nothing" shape
   * `TrashView.tsx` already had to fix once, and the grid offers nothing more
   * stable than the page title to land on instead.
   */
  const focusHeading = (): void => {
    headingRef.current?.focus();
  };

  const onConfirmDelete = (formId: string): void => {
    setDeleteErrors((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => id !== formId)),
    );
    setDeletingIds((prev) => new Set(prev).add(formId));
    deleteForm.mutate(formId, {
      onSuccess: () => {
        setConfirmingDeleteId(null);
        focusHeading();
      },
      onError: (error) => {
        // Closes the confirmation rather than leaving it open next to the
        // error: both are `role="alert"`, and two live regions announcing at
        // once on one card is the wrong way to say „das ging nicht" (the same
        // fix `TrashView.tsx` applies for the identical shape).
        setConfirmingDeleteId(null);
        setDeleteErrors((prev) => ({
          ...prev,
          [formId]: actionErrorMessage(error, TRASH_DELETE_FORM_SUBJECT),
        }));
      },
      onSettled: () => {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(formId);
          return next;
        });
      },
    });
  };

  /**
   * „⧉ Duplizieren" — unlike delete, nothing to confirm: a
   * duplicate adds a form, it does not take one away, and the prototype's own
   * `duplicateSurvey` fires on the click alone.
   */
  const onDuplicate = (formId: string): void => {
    setDuplicateErrors((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => id !== formId)),
    );
    setDuplicatingIds((prev) => new Set(prev).add(formId));
    duplicateForm.mutate(formId, {
      onError: (error) => {
        setDuplicateErrors((prev) => ({
          ...prev,
          [formId]: actionErrorMessage(error, FORM_DUPLICATE_SUBJECT),
        }));
      },
      onSettled: () => {
        setDuplicatingIds((prev) => {
          const next = new Set(prev);
          next.delete(formId);
          return next;
        });
      },
    });
  };

  const page = forms.data;
  const list = page?.items ?? [];
  /**
   * **The total number, not the loaded one** .
   *
   * All three read off the server's aggregates. `list.length` would be the
   * page — right up to twenty-four forms and quietly wrong from the
   * twenty-fifth on, which is the shape of defect that never gets reported
   * because the number *looks* plausible.
   */
  const kpis: readonly Kpi[] = [
    { label: 'Formulare', value: page?.total ?? 0 },
    { label: 'Aktiv', value: page?.activeTotal ?? 0, tone: 'success' },
    {
      label: 'Antworten gesamt',
      value: page?.responseTotal ?? 0,
      tone: 'accent',
    },
    { label: 'Organisationen', value: tenantCount },
  ];

  const total = page?.total ?? 0;
  const limit = page?.limit ?? FORM_PAGE_SIZE_DEFAULT;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const pageNumber = Math.min(pageCount, Math.floor(offset / limit) + 1);
  const isSearching = search !== '';

  /**
   * Puts the offset back inside the list after it shrank under the reader.
   *
   * Deleting the last card of the last page is the ordinary way there: the
   * refetch lands with a smaller `total`, the offset now points past the end
   * and the grid would be empty with „Weiter" greyed out and „Zurück" the only
   * way back to content.
   */
  useEffect(() => {
    if (offset > 0 && offset >= total) {
      setOffset(Math.max(0, (pageCount - 1) * limit));
    }
  }, [offset, total, pageCount, limit]);

  /**
   * Creating needs a name, and the **button says so** rather than sitting
   * there greyed out.
   *
   * A disabled control explains nothing: someone looking for "how do I start"
   * sees a dead button and a placeholder that vanishes as soon as they type
   * anywhere. So the button stays live, an empty name moves the focus into the
   * field and says what is missing — the user finds out by doing the obvious
   * thing instead of by guessing.
   */
  const onCreate = (): void => {
    const title = newTitle.trim();
    if (title === '') {
      setMissingTitle(true);
      titleField.current?.focus();
      return;
    }
    setMissingTitle(false);
    createForm.mutate(
      // The same way the builder already takes (`BuilderView`,
      // „Neues Formular" in the templates drawer): **one** place where a
      // form comes into being, and „with or without a template" is a branch
      // there instead of a second door (`createFormRequestSchema`).
      { title, ...(templateId === '' ? {} : { templateId }) },
      {
        onSuccess: (form) => {
          setNewTitle('');
          setTemplateId('');
          navigate(builderPath(form.id));
        },
      },
    );
  };

  return (
    <div className="dashboard">
      <div className="dashboard__head">
        {/*
          `tabIndex={-1}` so a card's deletion can put focus here — see
          {@link focusHeading}, the same technique `TrashView.tsx` uses for
          the identical shape.
        */}
        <h1 className="dashboard__title" ref={headingRef} tabIndex={-1}>
          Dashboard
        </h1>
        <p className="dashboard__subtitle">
          {tenantName === undefined
            ? 'Keine Organisation ausgewählt.'
            : `Alle Formulare von ${tenantName}`}
        </p>
      </div>

      {/*
        A session without a tenant scope is a dead end, not a detail: every
        tenant-bound request answers 403, so an empty screen would look like
        "nothing here yet" when it actually means "nothing is reachable". The
        server scopes a session at login only when there is exactly one
        membership, so an account with several lands here — and is told why
        and where to go, rather than being left to guess. The way
        out is in the header rather than in an e-mail to an administrator.
      */}
      {tenantName === undefined ? (
        <p className="dashboard__notice" role="status">
          {tenantCount === 0
            ? 'Diesem Konto ist noch keine Organisation zugeordnet. Solange das so ist, sind keine Formulare sichtbar – bitte wende dich an die Benutzerverwaltung.'
            : 'Die Anmeldung hat diese Sitzung keiner Organisation zugeordnet; das passiert, wenn mehrere Organisationen zur Auswahl stehen. Bitte oben im Kopf eine Organisation auswählen – bis dahin sind keine organisationsgebundenen Daten sichtbar.'}
        </p>
      ) : null}

      {/*
        **The setup of this Organisation** (ADR-0025) — either an
        invitation into the assistant or the list of open items, never both
        and mostly nothing. Which of the two is decided by the state: an
        Organisation without a single form is new, one with forms is
        running.

        `hasForms` comes **only out of the unfiltered list**: a search without
        hits says nothing about whether this Organisation has forms, and
        an invitation into the setup assistant that appears while typing in the
        search field would be the most confusing form of this notice.
      */}
      <TenantOpenItems
        tenantId={tenantId}
        permissions={permissions}
        hasForms={
          search === '' && forms.data !== undefined
            ? forms.data.total > 0
            : undefined
        }
      />

      {/*
        A description list, not a stack of divs: every tile is a term and its
        value, which is what `<dl>` means. It also makes the pair readable —
        a screen reader announces "Formulare, 0" instead of two loose numbers,
        and a test can ask for the value *belonging to* a label instead of
        walking up from the text node to its parent.

        `<dt>` comes first because the HTML standard says so within a group,
        and because that order is what produces "Formulare, 0" rather than
        "0, Formulare". The handoff puts the figure on top; that is the
        stylesheet's job (`column-reverse`), not the markup's — reordering the
        source to fake a visual order is exactly how the reading order and the
        visible order come apart.
      */}
      <dl className="dashboard__kpis">
        {kpis.map((kpi) => (
          <div className="dashboard__kpi" key={kpi.label}>
            <dt className="dashboard__kpi-label">{kpi.label}</dt>
            <dd
              className={
                kpi.tone === undefined
                  ? 'dashboard__kpi-value'
                  : `dashboard__kpi-value dashboard__kpi-value--${kpi.tone}`
              }
            >
              {kpi.value}
            </dd>
          </div>
        ))}
      </dl>

      {/*
        „+ Neues Formular" needs `canBuild`, and where it is missing the page
        **says so** rather than quietly dropping the box.

        Explaining, not hiding, and deliberately unlike the navigation entries
        next door: this is the one control on the landing page, and it is the
        first thing anyone looks for. With several organisations the same person finds
        it in Organisation A and not in Organisation B — a box that is simply gone reads as a
        page that failed to load, and there is nowhere else on this screen where
        the reason could be read. Naming the missing right also names the fix:
        it is the wording of the group editor („Bearbeiten"), so it can be asked
        for by name.
      */}
      {hasTenant && !canBuild ? (
        <p className="dashboard__notice" role="status">
          Formulare anlegen ist in dieser Organisation der Rolle „Bearbeiten"
          vorbehalten – dieser Zugang darf Formulare ansehen, aber keine neuen
          erstellen.
        </p>
      ) : null}

      {hasTenant && canBuild ? (
        <div className="dashboard__create">
          <div className="dashboard__create-row">
            <label className="dashboard__create-field">
              {/*
                A **visible** label, not only a placeholder. A placeholder is
                gone the moment someone types and invisible to anyone scanning
                the page for where to begin — which is exactly the moment this
                label is needed.
              */}
              <span className="dashboard__create-label">
                Name des neuen Formulars
              </span>
              <input
                ref={titleField}
                value={newTitle}
                placeholder="z. B. Bestandsmeldung 2026"
                aria-invalid={missingTitle}
                aria-describedby={
                  missingTitle ? 'dashboard-create-hint' : undefined
                }
                onChange={(event) => {
                  setNewTitle(event.target.value);
                  setMissingTitle(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onCreate();
                  }
                }}
              />
            </label>
            {/*
              **The template selection** (review finding 17).

              Until then it stood only in the builder, which meant: whoever
              wanted to start from a template had to open some form first.
              Creating goes through the same call as there — `templateId` on the
              `POST /forms` —, not through a second way.

              **If there are none, it is not there.** A select field with the
              single entry „Ohne Vorlage" is a question without an answer, and
              it would promise a feature this Organisation does not yet
              have. Templates are created in the builder („☆ Als Vorlage
              speichern").
            */}
            {formTemplates.length === 0 ? null : (
              <label className="dashboard__create-field dashboard__create-template">
                <span className="dashboard__create-label">Vorlage</span>
                <select
                  value={templateId}
                  onChange={(event) => {
                    setTemplateId(event.target.value);
                  }}
                >
                  <option value="">Ohne Vorlage</option>
                  {formTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="dashboard__create-button"
              // Only the in-flight request disables it. "No name yet" is
              // answered by `onCreate`, which says so and focuses the field.
              disabled={createForm.isPending}
              onClick={onCreate}
            >
              + Neues Formular
            </button>
            {/*
              **„✦ KI-Formular" — pulled over here** (finding 18).

              It stood as the last entry of the header navigation, among
              nothing but addresses, and was the only one that was none: it did
              not navigate, it opened a dialogue. What it does is create a
              form — and that is exactly what the button to its left does. Two
              ways to the same result belong next to each other, not spread
              over two floors.

              The conditions were pulled along: the feature has to exist
              (`aiFormsAvailable`) and this person has to be allowed to build.
              Both already hold here by half — this box is not rendered at all
              without `canBuild` —, and the box additionally stands only with an
              Organisation, which is right: the form produced belongs to one.
            */}
            {aiFormsAvailable ? (
              <button
                type="button"
                className="dashboard__create-ai"
                onClick={onOpenAiForm}
              >
                <span aria-hidden="true">✦ </span>KI-Formular
              </button>
            ) : null}
          </div>

          {missingTitle ? (
            <p
              className="dashboard__create-hint"
              id="dashboard-create-hint"
              role="alert"
            >
              Bitte zuerst einen Namen eingeben — er lässt sich später im
              Builder ändern.
            </p>
          ) : null}
        </div>
      ) : null}

      {createForm.isError ? (
        <p className="dashboard__notice" role="alert">
          Das Formular konnte nicht angelegt werden.
        </p>
      ) : null}

      {/*
        **The handoff's search bar**  — and it acts on the server
        . What is typed lands in `?q=`, and the answer
        is a page of the *matching* forms with a `total` of the matches; a
        filter over the loaded cards would answer „keine Treffer" for a form on
        page three, which the reader has no way to tell from „gibt es nicht".

        Only with a tenant: without one the list is not asked for at all, and a
        search field over nothing is a control that cannot do anything.
      */}
      {hasTenant ? (
        <div className="dashboard__search">
          <label className="dashboard__search-field">
            <span className="dashboard__search-label">
              Formulare durchsuchen
            </span>
            <input
              type="search"
              value={searchDraft}
              placeholder="z. B. Jahrestagung"
              onChange={(event) => {
                setSearchDraft(event.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="dashboard__search-reset"
            // The accessible name says *which* search — „Zurücksetzen" alone is
            // already the name of a button in the responses view and in the
            // fill view, and a locator matching by name should not be able to
            // land on the wrong one.
            aria-label="Suche zurücksetzen"
            disabled={searchDraft === ''}
            onClick={() => {
              setSearchDraft('');
            }}
          >
            Zurücksetzen
          </button>
          {/*
            The Trefferzähler of the handoff. `role="status"` so the number is
            announced rather than only drawn — the reader who typed cannot see
            the grid change if they are not looking at it.

            **The element is always mounted, and the *text* is what comes and
            goes** (review finding). A live region has to exist *before* its
            content changes for a screen reader to announce that change; a
            `<p role="status">` that appears together with its first sentence
            announces nothing, which is exactly the first search.

            **And it stays silent while the answer is stale.** `useFormPage`
            keeps the previous page on screen during a fetch
            (`placeholderData`), so between a new term and its answer `total`
            still belongs to the *old* one — without this guard the line read
            „2748 Treffer für „Jahrestagung"" and said so out loud.
          */}
          <p className="dashboard__search-count" role="status">
            {isSearching && !forms.isPlaceholderData && !forms.isPending
              ? countedHits(total, search)
              : ''}
          </p>
        </div>
      ) : null}

      {/* The card grid of the handoff. The grid stays in the markup even when
          empty, so the empty state sits where the cards will. */}
      <div className="dashboard__grid">
        {!hasTenant ? null : forms.isPending ? (
          <p className="dashboard__empty" role="status">
            Formulare werden geladen…
          </p>
        ) : forms.isError ? (
          <p className="dashboard__empty" role="alert">
            Die Formulare konnten nicht geladen werden.
          </p>
        ) : list.length === 0 ? (
          /*
            Two empty states, not one. „Noch keine Formulare vorhanden" over a
            search that found nothing would say the organisation is empty when it is
            the term that is — and the way out („anderes Wort", „Zurücksetzen")
            is a different one from „lege eins an".
          */
          isSearching ? (
            <p className="dashboard__empty">
              Kein Formular passt zur Suche.
              <span className="dashboard__empty-hint">
                Andere Schreibweise versuchen oder die Suche zurücksetzen.
              </span>
            </p>
          ) : (
            <p className="dashboard__empty">
              Noch keine Formulare vorhanden.
              <span className="dashboard__empty-hint">
                Sobald Formulare angelegt sind, erscheinen sie hier.
              </span>
            </p>
          )
        ) : (
          list.map((form) => (
            <FormCard
              key={form.id}
              form={form}
              isConfirmingDelete={confirmingDeleteId === form.id}
              onRequestDelete={() => {
                setConfirmingDeleteId(form.id);
              }}
              onCancelDelete={() => {
                setConfirmingDeleteId(null);
              }}
              onConfirmDelete={() => {
                onConfirmDelete(form.id);
              }}
              isDeleting={deletingIds.has(form.id)}
              deleteError={deleteErrors[form.id]}
              onDuplicate={() => {
                onDuplicate(form.id);
              }}
              isDuplicating={duplicatingIds.has(form.id)}
              duplicateError={duplicateErrors[form.id]}
            />
          ))
        )}
      </div>

      {/*
        **The paging control**  — drawn only when
        there is more than one page. A pager over a single page is two dead
        buttons and a sentence saying „Seite 1 von 1"; the reader learns
        nothing from it and has to read past it every time.

        `<nav>` with a name of its own, so the region is reachable and so a
        locator can be scoped to it — „Seite 1 von 3" is also what the public
        fill view says about *its* pages.
      */}
      {hasTenant && pageCount > 1 ? (
        <nav className="dashboard__pager" aria-label="Seiten der Formularliste">
          <button
            type="button"
            className="dashboard__pager-button"
            aria-label="Vorherige Seite der Formularliste"
            disabled={pageNumber <= 1}
            onClick={() => {
              setOffset(Math.max(0, offset - limit));
              // Landing on page one disables *this* button, and a browser
              // blurs a control it disables — focus falls to `<body>` and the
              // next Tab restarts at the top of the document. Same „focus that
              // falls into nothing" as a deleted card (see `focusHeading`),
              // and the state line is the nearest thing that stays.
              if (pageNumber - 1 <= 1) {
                pagerStateRef.current?.focus();
              }
            }}
          >
            Zurück
          </button>
          {/*
            `role="status"`, because pressing „Weiter" changes this line and
            nothing else that a screen reader would announce: the grid below is
            a silent swap of twenty-four cards.
          */}
          <p
            className="dashboard__pager-state"
            role="status"
            // `tabIndex={-1}` so a button that disables itself can hand focus
            // here — focusable by script, never by Tab, exactly as the page
            // heading is.
            tabIndex={-1}
            ref={pagerStateRef}
          >
            {`Seite ${String(pageNumber)} von ${String(pageCount)}`}
          </p>
          <button
            type="button"
            className="dashboard__pager-button"
            aria-label="Nächste Seite der Formularliste"
            disabled={pageNumber >= pageCount}
            onClick={() => {
              setOffset(offset + limit);
              // The mirror image of „Zurück" above — reaching the last page
              // disables this button under the pointer that pressed it.
              if (pageNumber + 1 >= pageCount) {
                pagerStateRef.current?.focus();
              }
            }}
          >
            Weiter
          </button>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * One card of the grid: title, status badge, date and answer
 * count, with „Bearbeiten" as the primary action.
 *
 * **„⧉ Duplizieren" arrived with the requirement.** Unlike „× Löschen" it asks
 * for no confirmation — a duplicate adds a form rather than taking one away,
 * and the prototype's own `duplicateSurvey` fires straight from the click.
 * **„× Löschen" arrived with the requirement** and is reversible: it moves the
 * form into the trash (`DELETE /forms/:id`, `canBuild` alone) rather than
 * deleting it physically, and the confirmation says so in as many words —
 * this is not the *endgültig* pair `TrashView.tsx` offers once something is
 * already there.
 *
 * **„Bearbeiten", „⧉ Duplizieren" and „× Löschen" are hidden without
 * `canBuild`** — hidden, not explained, unlike the create box above: the
 * reason is already stated once above the grid, and repeating it on every
 * card would turn one sentence into a wall of them. „Antworten" stays offered
 * either way; the responses view names its own 403 in words („Diese Rolle
 * darf die Antworten dieses Formulars nicht sehen"), so that button leads
 * somewhere that explains itself rather than into a dead end.
 *
 * **The flag is the card's own** (`FormSummary.permissions`, the requirement
 * no. 3), no longer the organisation-wide one the grid was handed: a per-form cap
 * lowers the role on one form and leaves the other cards alone, so this is a
 * decision each card has to make for itself. Somebody capped on the
 * Jahrestagung form to a role without `can_build` sees „Bearbeiten" on every
 * other card and not on that one — which is what the server would have
 * answered anyway, one 403 later.
 */
function FormCard({
  form,
  isConfirmingDelete,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  isDeleting,
  deleteError,
  onDuplicate,
  isDuplicating,
  duplicateError,
}: {
  readonly form: FormSummary;
  readonly isConfirmingDelete: boolean;
  readonly onRequestDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: () => void;
  readonly isDeleting: boolean;
  readonly deleteError: string | undefined;
  readonly onDuplicate: () => void;
  readonly isDuplicating: boolean;
  readonly duplicateError: string | undefined;
}): ReactElement {
  const canBuild = form.permissions.canBuild;
  const isActive = form.status === 'active';
  const updated = new Date(form.updatedAt).toLocaleDateString('de-DE');

  return (
    <article className="form-card">
      <div className="form-card__head">
        <h2 className="form-card__title">{form.title}</h2>
        <span
          className={
            isActive
              ? 'form-card__badge form-card__badge--active'
              : 'form-card__badge form-card__badge--draft'
          }
        >
          {isActive ? 'Aktiv' : 'Entwurf'}
        </span>
      </div>

      <p className="form-card__meta">zuletzt {updated}</p>
      <p className="form-card__meta">
        {form.responseCount === 1
          ? '1 Antwort'
          : `${String(form.responseCount)} Antworten`}
      </p>

      {deleteError === undefined ? null : (
        <p className="form-card__error" role="alert">
          {deleteError}
        </p>
      )}
      {duplicateError === undefined ? null : (
        <p className="form-card__error" role="alert">
          {duplicateError}
        </p>
      )}

      <div className="form-card__actions">
        {canBuild ? (
          <button
            type="button"
            className="form-card__primary"
            onClick={() => {
              navigate(builderPath(form.id));
            }}
          >
            Bearbeiten
          </button>
        ) : null}
        <button
          type="button"
          className="form-card__secondary"
          onClick={() => {
            navigate(responsesPath(form.id));
          }}
        >
          Antworten
        </button>
        {canBuild ? (
          <button
            type="button"
            className="form-card__duplicate"
            data-testid="form-card-duplicate"
            onClick={onDuplicate}
            disabled={isDuplicating}
          >
            <span aria-hidden="true">⧉ </span>
            {isDuplicating ? 'Wird dupliziert…' : 'Duplizieren'}
          </button>
        ) : null}
        {canBuild ? (
          <button
            type="button"
            className="form-card__delete"
            data-testid="form-card-delete"
            onClick={onRequestDelete}
            disabled={isDeleting || isConfirmingDelete}
          >
            <span aria-hidden="true">× </span>
            {isDeleting ? 'Wird gelöscht…' : 'Löschen'}
          </button>
        ) : null}
      </div>

      {isConfirmingDelete ? (
        <div className="form-card__confirm">
          <ConfirmPrompt
            question={`„${form.title}" wird in den Papierkorb verschoben und bleibt dort ${String(TRASH_RETENTION_DAYS)} Tage wiederherstellbar.`}
            confirmLabel="In den Papierkorb legen"
            // Reversible: the card lands in the trash, 30 Tage.
            tone="reversible"
            isPending={isDeleting}
            onConfirm={onConfirmDelete}
            onCancel={onCancelDelete}
          />
        </div>
      ) : null}
    </article>
  );
}
