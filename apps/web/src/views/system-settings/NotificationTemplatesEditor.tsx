import type { ReactElement } from 'react';
import {
  NOTIFICATION_TEMPLATES_FLOOR,
  NOTIFICATION_TEMPLATE_LIMIT,
  type NotificationTemplate,
  type NotificationTriggerInput,
} from '@formsache/shared';

import {
  SelectSetting,
  TextSetting,
  ToggleSetting,
  type SettingIssues,
} from '../settings/SettingsControls';

import '../settings-view.css';
import './notification-templates.css';

/**
 * **The editor of the notification templates** (ADR-0022, continuation
 * 2026-08-18) — the interface to the write path that did not exist until then.
 *
 * Pure and controlled, without hooks, without a route, without layout: the
 * same construction `TestMailCard` and the building blocks from `settings/`
 * have, and for the same reason — it stands in **two** places. Once as a tab
 * of the system administration (`SystemNotificationTemplatesTab`) and once as
 * step 5 of the setup wizard. Two versions would be two evaluations of the
 * field messages, and the drifting one would be the one nobody looks at as
 * long as all goes well.
 *
 * ## What a template is — and what it expressly is not
 *
 * A **starting point**, not a binding: on being applied it is **copied** into
 * the notification. Whoever changes something here therefore changes not a
 * single piece of mail that has already been sent or set up — the sentence
 * stands on the page as well, because that is the one question one asks
 * oneself before saving.
 *
 * ## Why the triggers are two switches and not a multiple choice
 *
 * There are exactly two of them (`notificationTriggerInputSchema`), they are
 * independent, and at least one has to be on. A `<select multiple>` would be
 * the more cumbersome control for two values and the unusable one on a phone.
 * That **both off** does not work is said by the line under the switches; it
 * is refused by the server, which has to enforce the rule anyway.
 */

const TRIGGER_LABELS: Record<NotificationTriggerInput, string> = {
  submit: 'Beim Absenden',
  edit: 'Bei nachträglicher Änderung',
};

const FORMAT_OPTIONS = [
  { value: 'html', label: 'HTML' },
  { value: 'text', label: 'Nur Text' },
];

/** The sentence when somebody switches both triggers off. */
export const NO_TRIGGER_MESSAGE =
  'Ohne einen Auslöser kann diese Vorlage nicht gespeichert werden — mindestens einer muss an sein.';

export interface NotificationTemplatesEditorProps {
  readonly templates: readonly NotificationTemplate[];
  readonly onChange: (next: readonly NotificationTemplate[]) => void;
  /**
   * Whether the stored row decides the templates, or whether the **shipped**
   * ones stand here right now.
   *
   * That is displayed with the same two words the inheritance uses elsewhere:
   * what one sees is either a standard or something adapted, and without the
   * difference nobody would know whether they are changing something or
   * confirming something.
   */
  readonly decided: boolean;
  /** Field messages of a 400, keyed by `templates.<index>.<feld>`. */
  readonly issues: SettingIssues;
}

export function NotificationTemplatesEditor({
  templates,
  onChange,
  decided,
  issues,
}: NotificationTemplatesEditorProps): ReactElement {
  const replace = (
    index: number,
    change: Partial<NotificationTemplate>,
  ): void => {
    onChange(
      templates.map((template, position) =>
        position === index ? { ...template, ...change } : template,
      ),
    );
  };

  return (
    <>
      <p className="settings__note">
        {decided
          ? 'Diese Installation hat eigene Vorlagen hinterlegt.'
          : 'Es sind die ausgelieferten Vorlagen zu sehen — hier ist noch nichts entschieden. Beim Speichern werden sie zu den Vorlagen dieser Installation.'}{' '}
        Eine Vorlage ist ein <strong>Startpunkt</strong>: sie wird beim Anwenden
        in die Benachrichtigung kopiert. Eine Änderung hier rührt deshalb keine
        bestehende Benachrichtigung an.
      </p>

      {templates.length === 0 ? (
        <p className="settings__note">
          Diese Installation bietet zurzeit keine Vorlagen an. Wer eine
          Benachrichtigung anlegt, fängt dann mit einem leeren Betreff und einem
          leeren Text an.
        </p>
      ) : null}

      {templates.map((template, index) => (
        <section
          className="settings-card"
          key={template.id}
          aria-labelledby={`template-${template.id}`}
        >
          <header className="settings-card__head">
            <div className="settings-card__text">
              {/*
                `h2` like every other settings card — and not `h3`, although the
                cards here form a list. Above them the tab sets only the `h1`
                „Systemverwaltung"; an `h3` would thereby skip a level, and axe
                counts that as a violation (`heading-order`). In the wizard the
                step's `h2` stands above it — two `h2` one after another skip
                nothing.
              */}
              <h2
                className="settings-card__heading"
                id={`template-${template.id}`}
              >
                {template.name === '' ? 'Ohne Namen' : template.name}
              </h2>
              <p className="settings-card__hint">
                Kennung <code>{template.id}</code>
              </p>
            </div>
            <button
              type="button"
              className="settings__secondary"
              onClick={() => {
                onChange(templates.filter((_, position) => position !== index));
              }}
            >
              Entfernen
            </button>
          </header>

          <div className="settings-card__body">
            <TextSetting
              label="Name"
              value={template.name}
              issue={issues[`templates.${String(index)}.name`]}
              note="Steht so im Auswahldialog und wird der Name der neuen Benachrichtigung."
              onChange={(name) => {
                replace(index, { name });
              }}
            />
            <TextSetting
              label="Beschreibung"
              value={template.description}
              issue={issues[`templates.${String(index)}.description`]}
              note="Eine Zeile: wann diese Vorlage die richtige Wahl ist."
              onChange={(description) => {
                replace(index, { description });
              }}
            />
            <TextSetting
              label="Betreff"
              value={template.subject}
              issue={issues[`templates.${String(index)}.subject`]}
              onChange={(subject) => {
                replace(index, { subject });
              }}
            />
            <TextSetting
              label="Text"
              value={template.body}
              multiline
              issue={issues[`templates.${String(index)}.body`]}
              note="Platzhalter wie {{antworten}} oder {{formular}} werden beim Versand eingesetzt — genau wie in der Benachrichtigung selbst."
              onChange={(body) => {
                replace(index, { body });
              }}
            />
            <SelectSetting
              label="Format"
              value={template.format}
              options={FORMAT_OPTIONS}
              issue={issues[`templates.${String(index)}.format`]}
              onChange={(format) => {
                replace(index, {
                  format: format === 'text' ? 'text' : 'html',
                });
              }}
            />

            {(['submit', 'edit'] as const).map((trigger) => (
              <ToggleSetting
                key={trigger}
                title={TRIGGER_LABELS[trigger]}
                checked={template.triggers.includes(trigger)}
                onChange={(on) => {
                  replace(index, {
                    triggers: on
                      ? [...template.triggers, trigger]
                      : template.triggers.filter((entry) => entry !== trigger),
                  });
                }}
              />
            ))}
            {template.triggers.length === 0 ? (
              <p className="settings__alert" role="alert">
                {NO_TRIGGER_MESSAGE}
              </p>
            ) : null}
            {issues[`templates.${String(index)}.triggers`] ===
            undefined ? null : (
              <p className="settings__alert" role="alert">
                {issues[`templates.${String(index)}.triggers`]}
              </p>
            )}

            <ToggleSetting
              title="Geht an die ausfüllende Person"
              note="Ein Vorschlag für den Editor: die E-Mail-Frage des Formulars wird dann als Empfänger vorgeschlagen. Wer wirklich Post bekommt, entscheidet die gespeicherte Benachrichtigung."
              checked={template.toSubmitter}
              onChange={(toSubmitter) => {
                replace(index, { toSubmitter });
              }}
            />
          </div>
        </section>
      ))}

      <div className="notification-templates__actions">
        <button
          type="button"
          className="settings__secondary"
          disabled={templates.length >= NOTIFICATION_TEMPLATE_LIMIT}
          onClick={() => {
            onChange([...templates, blankTemplate(templates)]);
          }}
        >
          Vorlage hinzufügen
        </button>
        {/*
          The shipped set as the way back. It is **not** a „zurück auf nichts
          entschieden": what is saved afterwards is a document that happens to
          say the same as the shipped set. The difference is visible in the
          server (`decided`) and written out here, so that nobody mistakes it
          for a deletion.
        */}
        <button
          type="button"
          className="settings__secondary"
          onClick={() => {
            onChange(
              NOTIFICATION_TEMPLATES_FLOOR.map((entry) => ({ ...entry })),
            );
          }}
        >
          Ausgelieferte Vorlagen einsetzen
        </button>
      </div>
      <p className="settings__footnote">
        Höchstens {NOTIFICATION_TEMPLATE_LIMIT} Vorlagen. „Ausgelieferte
        Vorlagen einsetzen" ersetzt die Liste durch die drei, die diese Fassung
        mitbringt — gespeichert wird sie erst mit „Speichern".
      </p>
    </>
  );
}

/**
 * An empty template with an id that does not exist yet.
 *
 * The id is **not** editable and is not guessed either: it is the React key
 * and the answer to "which template is this?", and a text field for it would
 * be a field in which two templates can be given the same name. The server
 * refuses duplicate ids; here they do not even come into being.
 */
function blankTemplate(
  existing: readonly NotificationTemplate[],
): NotificationTemplate {
  const taken = new Set(existing.map((entry) => entry.id));
  let index = existing.length + 1;
  while (taken.has(`vorlage-${String(index)}`)) {
    index += 1;
  }
  return {
    id: `vorlage-${String(index)}`,
    name: 'Neue Vorlage',
    description: 'Wofür diese Vorlage gedacht ist.',
    triggers: ['submit'],
    format: 'html',
    subject: '',
    body: '',
    toSubmitter: false,
  };
}
