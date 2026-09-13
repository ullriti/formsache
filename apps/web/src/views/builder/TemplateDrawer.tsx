import type { ReactElement, RefObject } from 'react';
import { useId, useState } from 'react';
import type { FormTemplateKind, FormTemplateSummary } from '@formsache/shared';

import { useFocusTrap } from '../../shell/use-focus-trap';
import { ConfirmPrompt } from '../tenant-admin/ConfirmPrompt';

/**
 * *Vorlagen & Blöcke* (Handoff) — the left slide-in with
 * the organisation's own saved blocks.
 *
 * **Two groups, and no third.** The prototype had a shipped catalogue beside
 * them („Anmeldung Jahrestagung", „Bestandsmeldung", fertige Fragenblöcke);
 * Konzept no. 71 removed it on 2026-08-03. What is left is what somebody in
 * this organisation saved: blocks that are inserted into the open form, and
 * whole forms that become a new one. An empty drawer is therefore a normal
 * first state and says so, rather than looking broken.
 *
 * A **form** template is not inserted into the document being edited — it makes
 * a new form and opens it. The prototype's own action replaced the pages of
 * whatever was open, which is a destructive gesture behind a one-click list;
 * making a row instead is the same convenience without the loss.
 *
 * **„Endgültig löschen", and only for whoever is allowed to** .
 * Two things follow from Konzept no. 72's decision of 2026-08-05, and both
 * are visible in `TemplateRow` below:
 *
 * - `onDelete` is **optional**. Without the right the button is *not there* —
 *   not disabled: a control that cannot act still promises
 *   the function, and the promise is the defect. Same shape as `canPurge` in
 *   `TrashView`.
 * - The caption is the **irreversible** of this project's two deletion terms.
 *   „Löschen" means the trash, restorable for 30 days; a template has no
 *   trash (`schema.prisma`), so it says „Endgültig löschen" and asks
 *   first, in {@link ConfirmPrompt}'s `'destructive'` tone. That tone is not
 *   decoration — the difference between the two was measured on rendered
 *   colours on 2026-08-03, and this row used to fire on the first click.
 *
 * **Renaming and updating** (2026-08-05) are the two
 * actions that keep a correction from becoming a second, identically named
 * template — and they are deliberately **not** rendered alike:
 *
 * - *Umbenennen* is reversible: it opens a field in the row and asks nothing.
 *   The **right** behind it is nonetheless the same pair as the two below
 *   (rework on no. 74) — the name is the only thing a template is
 *   recognised by, so an organisation-mate's row can be renamed and the name reused.
 *   That is a permission question, not a rendering one: the gesture stays
 *   quiet, the button is simply absent for whoever may not press it.
 * - *Aus diesem Formular aktualisieren* **overwrites content that has no
 *   trash**. It asks first, in the same `'destructive'` tone as the
 *   deletion above, and the question **names what it is about to overwrite
 *   with** — the open page by its title, the selected question by its text.
 *   „die aktuell geöffnete Seite" alone was true and useless: with the wrong
 *   page open the old content is gone and there is no trash.
 *
 * All three are absent — not disabled — where the right is missing.
 */
export function TemplateDrawer({
  templates,
  isPending,
  isError,
  error,
  busyTemplateId,
  openerRef,
  onClose,
  onInsert,
  onCreateForm,
  updateSource,
  onRename,
  onUpdate,
  onDelete,
}: {
  readonly templates: readonly FormTemplateSummary[];
  readonly isPending: boolean;
  readonly isError: boolean;
  /**
   * What the last action in this drawer said went wrong, or `null`.
   *
   * Shown here rather than swallowed: renaming, updating and deleting
   * close their prompt at once, so without this line there would be **no**
   * place at which a failed overwrite would become visible — and the
   * reader would take the template to have been changed.
   */
  readonly error: string | null;
  /** The row with a request in flight — its buttons stay pressed. */
  readonly busyTemplateId: string | null;
  /** The „▤ Vorlagen" button, so focus can return to it. */
  readonly openerRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onInsert: (template: FormTemplateSummary) => void;
  readonly onCreateForm: (template: FormTemplateSummary) => void;
  /**
   * **What** „Aus diesem Formular aktualisieren" would copy from right now —
   * the title of the open page and the text of the selected question, or
   * `null` when there is none.
   *
   * It stands in the prompt, and that is the reason for the prop: the caller
   * sends `activePage(state)` or `selectedQuestion(state)`, and if that
   * is a different page from the one the reader had in mind, the old
   * content is gone — for templates there is no trash. The name therefore
   * belongs in the sentence in which the decision is made, not in the code
   * that carries it out afterwards.
   */
  readonly updateSource: UpdateSource;
  /**
   * Absent without the pair — renaming replaces what stands under the one name
   * a template is recognised by (rework on Konzept no. 74).
   */
  readonly onRename?: (template: FormTemplateSummary, name: string) => void;
  /**
   * Absent without the pair — this one **overwrites** the template's content
   * from the open form, and nothing brings the old content back.
   */
  readonly onUpdate?: (template: FormTemplateSummary) => void;
  /**
   * Absent when the viewer may not delete — the button then does not exist.
   * See the component's own comment for why it is not a `disabled` flag.
   */
  readonly onDelete?: (template: FormTemplateSummary) => void;
}): ReactElement {
  const titleId = useId();
  const { panelRef, onKeyDown } = useFocusTrap({ onClose, openerRef });
  /**
   * Which row is asking, and about what — **one row and one question at a
   * time**, as in `TrashView`.
   *
   * One piece of state for the three of them rather than three, because they
   * are mutually exclusive by construction: a row that is being renamed is not
   * also asking whether to throw its content away, and two open boxes in a
   * 320 px drawer would be a choice nobody meant to offer.
   */
  const [open, setOpen] = useState<{
    readonly id: string;
    readonly action: 'rename' | 'update' | 'delete';
  } | null>(null);

  const blocks = templates.filter((template) => template.kind !== 'form');
  const forms = templates.filter((template) => template.kind === 'form');

  const close = (): void => {
    setOpen(null);
  };

  /**
   * The controls of one row — each of them absent without its right.
   *
   * Built here rather than in `TemplateRow` for the reason `BuilderView`'s
   * `templateControls` states: the list is rendered twice (blocks and forms),
   * and two copies of the same handlers are two places to drift apart.
   */
  const controlsFor = (template: FormTemplateSummary): RowControls => ({
    ...(onRename === undefined
      ? {}
      : {
          rename: {
            isOpen: open?.id === template.id && open.action === 'rename',
            onRequest: () => {
              setOpen({ id: template.id, action: 'rename' });
            },
            onCancel: close,
            onSubmit: (name: string) => {
              close();
              onRename(template, name);
            },
          },
        }),
    ...(onUpdate === undefined
      ? {}
      : {
          update: {
            isConfirming: open?.id === template.id && open.action === 'update',
            onRequest: () => {
              setOpen({ id: template.id, action: 'update' });
            },
            onCancel: close,
            onConfirm: () => {
              close();
              onUpdate(template);
            },
          },
        }),
    ...(onDelete === undefined
      ? {}
      : {
          deletion: {
            isConfirming: open?.id === template.id && open.action === 'delete',
            onRequest: () => {
              setOpen({ id: template.id, action: 'delete' });
            },
            onCancel: close,
            onConfirm: () => {
              close();
              onDelete(template);
            },
          },
        }),
  });

  return (
    <div className="template-drawer">
      {/* Redundant convenience: Escape and „✕" do the same, so this stays out
          of the accessibility tree instead of becoming a second, unlabelled
          close control. */}
      <div
        className="template-drawer__scrim"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="template-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="template-drawer__head">
          <h2 className="template-drawer__title" id={titleId}>
            Vorlagen &amp; Blöcke
          </h2>
          <button
            type="button"
            className="template-drawer__close"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
            <span className="visually-hidden">Schließen</span>
          </button>
        </div>

        <div className="template-drawer__body">
          {isPending ? (
            <p className="template-drawer__state" role="status">
              Vorlagen werden geladen…
            </p>
          ) : null}
          {isError ? (
            <p className="template-drawer__state" role="alert">
              Die Vorlagen konnten nicht geladen werden.
            </p>
          ) : null}
          {error === null ? null : (
            <p className="template-drawer__state" role="alert">
              {error}
            </p>
          )}
          {!isPending && !isError && templates.length === 0 ? (
            <p className="template-drawer__state">
              Noch keine Vorlagen. Speichern Sie eine Frage, eine Seite oder ein
              ganzes Formular mit „☆ Als Vorlage speichern".
            </p>
          ) : null}

          {blocks.length > 0 ? (
            <TemplateGroup
              title="Meine Vorlagen"
              subtitle="Selbst gespeicherte Fragen & Seiten."
            >
              {blocks.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  icon={template.kind === 'page' ? '▤' : '＋'}
                  description={
                    template.kind === 'page'
                      ? `${String(template.questionCount)} Fragen · als Seite`
                      : 'Einzelfrage'
                  }
                  action={template.kind === 'page' ? 'Als Seite' : 'Einfügen'}
                  busy={busyTemplateId === template.id}
                  onUse={() => {
                    onInsert(template);
                  }}
                  controls={controlsFor(template)}
                  updateSource={updateSource}
                />
              ))}
            </TemplateGroup>
          ) : null}

          {forms.length > 0 ? (
            <TemplateGroup
              title="Komplette Formular-Vorlagen"
              subtitle="Ein Klick legt daraus ein neues Formular an."
            >
              {forms.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  icon="▦"
                  description={`${String(template.questionCount)} Fragen · ganzes Formular`}
                  action="Neues Formular"
                  busy={busyTemplateId === template.id}
                  onUse={() => {
                    onCreateForm(template);
                  }}
                  controls={controlsFor(template)}
                  updateSource={updateSource}
                />
              ))}
            </TemplateGroup>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TemplateGroup({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactElement[];
}): ReactElement {
  return (
    <section className="template-drawer__group" aria-label={title}>
      <h3 className="template-drawer__group-title">{title}</h3>
      <p className="template-drawer__group-sub">{subtitle}</p>
      <ul className="template-drawer__list">{children}</ul>
    </section>
  );
}

/** What a row needs to ask before an irreversible act; absent means: no button. */
interface RowConfirm {
  readonly isConfirming: boolean;
  readonly onRequest: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** What a row needs to offer „Umbenennen" — reversible, so it asks nothing. */
interface RowRename {
  readonly isOpen: boolean;
  readonly onRequest: () => void;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}

/**
 * The three optional controls of a row. `| undefined` explicit throughout —
 * `exactOptionalPropertyTypes` is on, and absent is the whole point.
 */
interface RowControls {
  readonly rename?: RowRename | undefined;
  readonly update?: RowConfirm | undefined;
  readonly deletion?: RowConfirm | undefined;
}

/**
 * What „Aus diesem Formular aktualisieren" copies, per kind — the *source*, in
 * the words the builder shows it in.
 *
 * A template keeps its kind (the server refuses a body that would change it), so
 * a page template is refreshed from the page currently open and a
 * question template from the selected question. Naming that here rather than a
 * single „aus diesem Formular" for all three is the difference between „ich
 * weiß, was gleich überschrieben wird" and a guess.
 */
const UPDATE_SOURCE: Readonly<
  Record<FormTemplateKind, { readonly from: string; readonly by: string }>
> = {
  // `from` stands after „aus …" (caption), `by` after „durch … ersetzt"
  // (prompt) — two cases of the same word, instead of one sentence that is
  // wrong in one of the two.
  form: { from: 'diesem Formular', by: 'dieses Formular' },
  page: {
    from: 'der aktuell geöffneten Seite',
    by: 'die aktuell geöffnete Seite',
  },
  question: { from: 'der ausgewählten Frage', by: 'die ausgewählte Frage' },
};

/** The title of the open page and the text of the selected question. */
export interface UpdateSource {
  readonly pageTitle: string | null;
  readonly questionLabel: string | null;
}

/**
 * The source for the **prompt** — with a name, where there is one.
 *
 * `UPDATE_SOURCE[kind].by` says *what kind* of thing is about to be copied;
 * this function says **which one**. That is the difference at stake: „die
 * aktuell geöffnete Seite" is always true, even when the wrong one is open,
 * and afterwards the template's old content is gone (no trash).
 *
 * Falls back to the kind alone when nothing is selected. The call
 * fails before the network anyway then — `BuilderView` reports „Es ist nichts
 * ausgewählt" —, and an empty pair of quotation marks in the question would be
 * worse than the general sentence.
 */
function updateSourceOf(kind: FormTemplateKind, source: UpdateSource): string {
  const { by } = UPDATE_SOURCE[kind];
  const named =
    kind === 'page'
      ? source.pageTitle
      : kind === 'question'
        ? source.questionLabel
        : null;
  const trimmed = named?.trim() ?? '';
  return trimmed === '' ? by : `${by} „${trimmed}"`;
}

function TemplateRow({
  template,
  icon,
  description,
  action,
  busy,
  onUse,
  controls,
  updateSource,
}: {
  readonly template: FormTemplateSummary;
  readonly icon: string;
  readonly description: string;
  readonly action: string;
  readonly busy: boolean;
  readonly onUse: () => void;
  readonly controls: RowControls;
  readonly updateSource: UpdateSource;
}): ReactElement {
  const { rename, update, deletion } = controls;
  const asking =
    update?.isConfirming === true || deletion?.isConfirming === true;

  return (
    <li className="template-drawer__row">
      <div className="template-drawer__row-main">
        <button
          type="button"
          className="template-drawer__use"
          disabled={busy}
          onClick={onUse}
        >
          <span className="template-drawer__icon" aria-hidden="true">
            {icon}
          </span>
          <span className="template-drawer__text">
            <span className="template-drawer__name">{template.name}</span>
            <span className="template-drawer__desc">{description}</span>
          </span>
          <span className="template-drawer__action">{action}</span>
        </button>
        {rename === undefined ? null : (
          <button
            type="button"
            className="template-drawer__side"
            disabled={busy || rename.isOpen}
            onClick={rename.onRequest}
          >
            <span aria-hidden="true">✎</span>
            <span className="visually-hidden">
              Vorlage „{template.name}" umbenennen
            </span>
          </button>
        )}
        {update === undefined ? null : (
          <button
            type="button"
            className="template-drawer__side"
            disabled={busy || asking}
            onClick={update.onRequest}
          >
            <span aria-hidden="true">⟳</span>
            {/* The name of the action suggests a subscription; it is a
                one-off overwrite — the prompt says so
                in whole sentences. */}
            <span className="visually-hidden">
              Vorlage „{template.name}" aus {UPDATE_SOURCE[template.kind].from}{' '}
              aktualisieren
            </span>
          </button>
        )}
        {deletion === undefined ? null : (
          <button
            type="button"
            className="template-drawer__delete"
            disabled={busy || asking}
            onClick={deletion.onRequest}
          >
            <span aria-hidden="true">🗑</span>
            {/* The irreversible of the two deletion terms — „löschen" alone
                would mean „into the trash" in this application, and there
                is none for a template. */}
            <span className="visually-hidden">
              Vorlage „{template.name}" endgültig löschen
            </span>
          </button>
        )}
      </div>
      {rename?.isOpen === true ? (
        <RenameField
          template={template}
          onSubmit={rename.onSubmit}
          onCancel={rename.onCancel}
        />
      ) : null}
      {update?.isConfirming === true ? (
        <ConfirmPrompt
          question={`Der Inhalt der Vorlage „${template.name}" wird durch ${updateSourceOf(template.kind, updateSource)} ersetzt. Das lässt sich nicht rückgängig machen — für Vorlagen gibt es keinen Papierkorb. Bereits eingefügte Kopien bleiben, wie sie sind.`}
          confirmLabel="Inhalt ersetzen"
          tone="destructive"
          onConfirm={update.onConfirm}
          onCancel={update.onCancel}
        />
      ) : null}
      {deletion?.isConfirming === true ? (
        <ConfirmPrompt
          question={`Die Vorlage „${template.name}" wird endgültig gelöscht. Das lässt sich nicht rückgängig machen — für Vorlagen gibt es keinen Papierkorb.`}
          confirmLabel="Endgültig löschen"
          tone="destructive"
          onConfirm={deletion.onConfirm}
          onCancel={deletion.onCancel}
        />
      ) : null}
    </li>
  );
}

/**
 * „Umbenennen" — a field in the row, **no prompt** .
 *
 * No `ConfirmPrompt` and no tone, because there is nothing to warn about: the
 * content is untouched and the old name can be typed back. Asking anyway would
 * spend the one gesture this drawer reserves for „das kommt nicht zurück" on
 * something that does.
 *
 * A `form`, so Enter submits and Escape is handled by the drawer's focus trap
 * the way it is everywhere else in this panel.
 */
function RenameField({
  template,
  onSubmit,
  onCancel,
}: {
  readonly template: FormTemplateSummary;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const fieldId = useId();
  const [name, setName] = useState(template.name);
  const trimmed = name.trim();

  return (
    <form
      className="template-drawer__rename"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(trimmed);
      }}
    >
      <label className="visually-hidden" htmlFor={fieldId}>
        Neuer Name der Vorlage „{template.name}"
      </label>
      <input
        id={fieldId}
        className="template-drawer__rename-field"
        value={name}
        autoFocus
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <button type="button" onClick={onCancel}>
        Abbrechen
      </button>
      <button
        type="submit"
        className="template-drawer__rename-save"
        disabled={trimmed === '' || trimmed === template.name}
      >
        Umbenennen
      </button>
    </form>
  );
}
