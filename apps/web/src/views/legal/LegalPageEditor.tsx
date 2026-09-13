import { useId, useState, type ReactElement } from 'react';
import {
  editableConditions,
  groupedSlots,
  legalPageStatus,
  renderLegalPage,
  visibleSlots,
  LEGAL_FILL_MAX,
  LEGAL_LINK_MAX,
  LEGAL_TEXT_MAX,
  type LegalDocument,
  type LegalPageStatus,
  type LegalRenderContext,
  type LegalSlot,
  type LegalTemplate,
} from '@formsache/shared';

import { TextSetting, type SettingIssues } from '../settings/SettingsControls';
import { LegalText } from './LegalText';

import './legal.css';
import './legal-editor.css';

/**
 * **One legal text, edited** (ADR-0028) — the one interface for all five
 * pages, in the system settings as in the organisation settings.
 *
 * ## The three ways, and why the first is the standard way
 *
 * 1. **Fill in the template.** The reviewed version from
 *    `docs/legal/vorlagen/` stands, and what is missing are **fields** — not a
 *    body of running text in which somebody has to search for `[[…]]`. That is
 *    the whole difference: a field can be forgotten and then seen; a
 *    placeholder in the middle of eight pages of text gets overlooked, and an
 *    unchecked published placeholder is worse than an empty field.
 * 2. **Own text.** Whoever has a version reviewed by a lawyer writes it down.
 *    Then theirs applies.
 * 3. **Verweis auf eine Seite** (Review-Runde 5, Nachtrag). Wer den Text schon
 *    woanders stehen hat, nennt dessen Adresse, statt ihn ein zweites Mal zu
 *    pflegen. Die Seite verweist dann dorthin — und zeigt darunter den festen
 *    Teil, wo die Vorlage einen hat.
 *
 * **The switch loses nothing.** All three halves stand side by side in the
 * document (`legal.ts`), so on switching over what was typed stays — and on
 * switching back it is there again. The sentence above the switch says so, so
 * that nobody tries nothing out just to be safe.
 *
 * ## Only the fields that currently apply
 *
 * {@link visibleSlots} leaves out the placeholders from deselected blocks. A
 * natural person should not be asked for their register court, and a page with
 * 32 input fields, 20 of which do not apply, does not get filled in but
 * clicked away.
 *
 * ## The preview
 *
 * It renders **the same** way as the public page
 * (`renderLegalPage` → `LegalText`), only out of the unsaved draft. A second
 * render path would be a second truth about what a legal text looks like — and
 * the one that drifts off would be the one nobody sees published.
 */
export interface LegalPageEditorProps {
  readonly template: LegalTemplate;
  readonly document: LegalDocument;
  readonly onChange: (next: LegalDocument) => void;
  /**
   * What the application knows about itself when rendering the **preview**.
   *
   * ⚠️ `aiActive` **kann** hier eine Annahme sein statt der Wahrheit des
   * Servers: die KI-Konfiguration ist eine Systemeinstellung, die eine
   * Organisation nicht sehen darf. Welcher der beiden Fälle vorliegt, sagt
   * {@link aiStateKnown} — und der Satz unter der Vorschau sagt es der Person,
   * statt so zu tun, als wüsste sie es.
   */
  readonly context: LegalRenderContext;
  /**
   * The address of the published page — for looking it up in its real state.
   *
   * **Optional**, since a form's privacy notice uses the same interface
   * (ADR-0028 no. 4): that one has no page of its own but stands on the public
   * pages of its form. Inventing a link would be a control that leads nowhere;
   * the sentence about the derived sections then falls away with it, because
   * without the link it says nothing any more.
   */
  readonly publicPath?: string;
  /**
   * The field messages of a 400, named **after the paths of this document**:
   * `custom` and `fills.<SCHLÜSSEL>`.
   *
   * Not after the paths of the request the document sits in: the same editor
   * carries six legal texts at three different places of three different
   * payloads (`privacyNotice.…` on the form settings page, `pages.<seite>.…`
   * at organisation and installation). Which prefix is to be stripped is known
   * by the caller; this building block knows only the document it edits
   * (`fieldIssues` and `issuesUnder` in `views/api-messages.ts` — the latter
   * because at organisation and installation *several* of these cards stand on
   * one screen and the page name is what tells them apart, ADR-0028 no. 9).
   *
   * **Why this is needed at all** (review finding of 2026-08-19): without this
   * path every 400 on this sub-document ended at „Bitte die markierten Felder
   * prüfen." — and nothing was marked. A `maxLength` on the fields below
   * catches the *one* limit that exists today; this path catches every further
   * one the schema draws in future.
   */
  readonly issues?: SettingIssues;
  /**
   * Welche Felder dieser Seite auch in einer Nachbarseite stehen und deshalb
   * mitgeführt werden (Review-Runde 3 Nr. 3).
   *
   * Nur für den **Satz am Feld**: das Mitführen selbst macht der Aufrufer
   * (`applySharedFills`), weil nur er die anderen Seiten hat. Ein Wert, der
   * sich beim Tippen woanders mitändert, ohne dass es dort steht, wäre die
   * unangenehmste Art von Hilfsbereitschaft.
   *
   * Fehlt sie, steht kein Satz — der Datenschutzhinweis eines Formulars steht
   * allein und teilt nichts.
   */
  readonly sharedSlots?: ReadonlySet<string>;
  /**
   * Ob `context.aiActive` der Zustand **des Servers** ist und nicht die Annahme
   * dieser Ansicht (Review-Runde 5 Nr. 2).
   *
   * Nur für den Satz unter der Vorschau: die Karte der **Installation** kennt
   * ihn seit Review-Runde 5 (er reist mit den Dokumenten mit), die einer
   * **Organisation** kann ihn nicht kennen — die KI-Einstellungen sind
   * Systemeinstellungen, die eine Organisation nicht sehen darf. Ein Satz, der
   * „der Absatz zur KI steht hier vielleicht falsch" behauptet, wo er richtig
   * steht, ist genau die Auskunft, die man beim dritten Mal nicht mehr liest.
   */
  readonly aiStateKnown?: boolean;
}

const STATUS_LABELS: Record<LegalPageStatus, string> = {
  empty: 'Nichts hinterlegt',
  incomplete: 'Unvollständig',
  ready: 'Vollständig',
};

export function LegalPageEditor({
  template,
  document,
  onChange,
  context,
  publicPath,
  issues = {},
  sharedSlots,
  aiStateKnown = false,
}: LegalPageEditorProps): ReactElement {
  const headingId = useId();
  const modeName = useId();
  const status = legalPageStatus(template, document, context);
  const slots = visibleSlots(template, document, context);
  const conditions = editableConditions(template);
  /*
    **`'editor'`, und das ist hier die ganze Aussage** (Review-Runde 5 Nr. 1):
    die veröffentlichte Seite lässt eine Zeile mit offener Angabe weg, diese
    Vorschau zeigt sie benannt. Sie ist die eine Ansicht, in der eine Lücke
    hingehört — sie steht neben dem Feld, das sie schließt.
  */
  const preview = renderLegalPage(template, document, context, 'editor');
  /*
    **Wie weit ist diese Seite** — als Zahl, nicht nur als Wort
    (Review-Runde 3 Nr. 16: „für einen Laien doch etwas komplex").

    „Unvollständig" sagt, *dass* etwas fehlt, und lässt offen, ob es ein Feld
    ist oder elf. Vor einer Liste mit zwanzig Feldern ist das der Unterschied
    zwischen „gleich fertig" und „das mache ich morgen" — und genau diese
    Auskunft fehlte.

    Gezählt werden die **sichtbaren** Felder, also die der gerade
    ausgewählten Abschnitte: ein Feld aus einem abgewählten Block gehört zu
    keiner Aufgabe.
  */
  const openSlots = slots.filter(
    (slot) =>
      // **Freiwillige Felder sind keine Aufgabe** (Review-Runde 5, Nachtrag):
      // „noch 3 Felder" und der Zustand daneben müssen dasselbe zählen, sonst
      // steht „Vollständig — noch 1 Feld" da.
      slot.optional !== true && (document.fills[slot.key] ?? '').trim() === '',
  ).length;

  /*
    **Ob der Weg zur zweiten Fassung offen steht** — ein Zustand dieser Karte
    und ausdrücklich *keine* Ableitung aus `document.mode`.

    Das ist der Kern der Sache: das Aufklappen gehört der Person, die es
    aufklappt, und es darf nicht von der Wahl abhängen, die *darin* getroffen
    wird. Hinge es daran, klappte sich der Kasten unter der Hand zu, sobald
    jemand „Vorlage ausfüllen" wählt — der eben noch angeklickte Schalter wäre
    weg, und der Weg zurück ebenfalls. Genau daran scheiterte der erste Anlauf
    (E2E „der Moduswechsel verliert nichts").

    Der Anfangswert schaut ein einziges Mal auf den Modus, und dafür ist er da:
    wer einen eigenen Text hinterlegt hat, sieht die Wahl beim Aufschlagen der
    Seite offen — der Weg zurück zur Vorlage liegt nicht in einem zugeklappten
    Kasten. Alle drei Aufrufer zeigen diese Karte erst, wenn die gespeicherte
    Fassung da ist, der Modus steht beim Einhängen also schon fest.
  */
  const [choiceOpen, setChoiceOpen] = useState(document.mode !== 'template');

  /**
   * Ein Feld der Vorlage.
   *
   * Als benannte Funktion und nicht dreimal abgeschrieben: seit den
   * Abschnitten (Review-Runde 4 Nr. 7) wird sie aus zwei Zweigen heraus
   * aufgerufen, und zwei Kopien wären zwei Gelegenheiten, den
   * Standardtext-Knopf nur an einer Stelle nachzuziehen.
   */
  const field = (slot: LegalSlot): ReactElement => {
    const value = document.fills[slot.key] ?? '';
    const note = noteFor(slot.hint, sharedSlots?.has(slot.key) === true);
    // Ein übernehmbarer Standardtext steht auch als Beispiel im leeren Feld —
    // ein Vorschlag, den man nur als Knopf sieht, ist einer, den man beim
    // Tippen nicht kennt.
    const placeholder = slot.example ?? slot.suggestion;
    const fill = (next: string): void => {
      onChange({ ...document, fills: { ...document.fills, [slot.key]: next } });
    };
    return (
      <div className="legal-editor__field" key={slot.key}>
        <TextSetting
          /*
            **„(optional)" in der Beschriftung und nicht im Hinweissatz**
            (Review-Runde 5, Nachtrag). Wer eine Liste mit zwanzig Feldern
            überfliegt, liest Beschriftungen und keine Sätze darunter — und wer
            sie sich vorlesen lässt, hört die Beschriftung ohnehin zuerst. Der
            Hinweis daneben sagt weiterhin, **warum** es freiwillig ist.
          */
          label={
            slot.optional === true ? `${slot.label} (optional)` : slot.label
          }
          value={value}
          multiline={slot.multiline === true}
          maxLength={LEGAL_FILL_MAX}
          issue={issues[`fills.${slot.key}`]}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(note === undefined ? {} : { note })}
          onChange={fill}
        />
        {/*
          **Der übernehmbare Standardtext** (Review-Runde 4 Nr. 5). Nur, wo die
          Vorlage einen anbietet, und nur, solange das Feld leer ist: ein Knopf
          neben einem geschriebenen Satz wäre ein Angebot, ihn zu überschreiben,
          und das ist keins.

          Bewusst ein Knopf und keine Vorbelegung — der Unterschied ist genau
          eine bewusste Handlung. Ein Rechtstext, den niemand gelesen hat, weil
          er schon dastand, ist die stille Art der Falschangabe.
        */}
        {slot.suggestion === undefined || value.trim() !== '' ? null : (
          <button
            type="button"
            className="legal-editor__suggestion"
            onClick={() => {
              fill(slot.suggestion ?? '');
            }}
          >
            Vorschlag übernehmen{' '}
            {/*
              **Der Name des Feldes gehört in die Beschriftung.** Sichtbar
              steht der Knopf unter seinem Feld und die Zuordnung ist klar;
              wer die Knöpfe einer Seite hintereinander hört, hörte sonst
              dreimal denselben Satz und wüsste bei keinem, wozu er gehört.
            */}
            <span className="visually-hidden">— {slot.label}</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <section className="settings-card" aria-labelledby={headingId}>
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id={headingId}>
            {template.title}
          </h2>
          <p className="settings-card__hint">{template.purpose}</p>
        </div>
        {/*
          The state as a badge, not as colour alone: „Unvollständig" stands
          where somebody reads it, and `data-status` colours it. Whoever does
          not see the colour reads the word.
        */}
        <span className="legal-editor__status" data-status={status}>
          {/*
            **Das Wort in einem eigenen Element** — und das ist kein
            Markup-Geschmack: das Wort ist der Zustand („Nichts hinterlegt",
            „Unvollständig", „Vollständig"), die Zahl daneben ist die Aufgabe.
            Wer den Zustand sucht — ein Mensch wie ein Test —, sucht das Wort,
            und ein Kasten, dessen Text „Unvollständig — noch 3 Felder" lautet,
            trägt es nicht mehr für sich.
          */}
          <span className="legal-editor__status-word">
            {STATUS_LABELS[status]}
          </span>
          {/*
            Die Zahl daneben, wenn es etwas zu zählen gibt: „Unvollständig —
            noch 3 Felder" ist eine Aufgabe, „Unvollständig" ist ein Vorwurf.
            Nur im Vorlagen-Modus, denn im eigenen Text gibt es keine Felder.
          */}
          {document.mode === 'template' && openSlots > 0 ? (
            <span className="legal-editor__status-count">
              {openSlots === 1
                ? '— noch 1 Feld'
                : `— noch ${String(openSlots)} Felder`}
            </span>
          ) : null}
        </span>
      </header>

      <div className="legal-editor">
        {document.mode === 'template' ? (
          <>
            {conditions.length === 0 ? null : (
              <fieldset className="legal-editor__conditions">
                <legend>Welche Abschnitte gelten?</legend>
                <p className="legal-editor__note">
                  Ein Abschnitt, den niemand ausgewählt hat, entfällt ganz — mit
                  seinen Feldern. Was zutrifft, weiß nur die verantwortliche
                  Stelle; die Anwendung rät es nicht.
                </p>
                {conditions.map((condition) => (
                  <ConditionToggle
                    key={condition.key}
                    label={condition.label}
                    {...(condition.hint === undefined
                      ? {}
                      : { hint: condition.hint })}
                    checked={document.conditions[condition.key] === true}
                    onChange={(checked) => {
                      onChange({
                        ...document,
                        conditions: {
                          ...document.conditions,
                          [condition.key]: checked,
                        },
                      });
                    }}
                  />
                ))}
              </fieldset>
            )}

            {/*
              **Die Felder in fachlichen Abschnitten** (Review-Runde 4 Nr. 7:
              „Mailserver und Backup Felder haben falsche Reihenfolge und
              werden vermischt").

              Die Einteilung selbst steht in der Vorlage
              ({@link LegalSlot.group}) und nicht hier: welches Feld fachlich
              wohin gehört, weiß der Text, nicht die Anzeige. Was hier steht,
              ist allein, dass ein Abschnitt eine Überschrift bekommt.

              Eine Vorlage ohne Abschnitte — der Datenschutzhinweis eines
              Formulars hat sechs Felder — liefert genau eine namenlose
              Gruppe, und dann steht hier dieselbe flache Liste wie zuvor.
              Deshalb `<fieldset>` nur mit Titel: eine Gruppe ohne Namen wäre
              ein Rahmen um alles und eine Auskunft über nichts.
            */}
            {groupedSlots(slots).map((group) =>
              group.title === null ? (
                <div className="legal-editor__fields" key="ohne-abschnitt">
                  {group.slots.map(field)}
                </div>
              ) : (
                <fieldset className="legal-editor__group" key={group.title}>
                  <legend>{group.title}</legend>
                  <div className="legal-editor__fields">
                    {group.slots.map(field)}
                  </div>
                </fieldset>
              ),
            )}
          </>
        ) : document.mode === 'link' ? (
          <div className="legal-editor__fields">
            <TextSetting
              label="Adresse der Seite"
              value={document.link}
              maxLength={LEGAL_LINK_MAX}
              issue={issues.link}
              placeholder="https://musterverein.example/impressum"
              note={
                'Die vollständige Adresse mit https://. Die Seite hier zeigt ' +
                'dann diesen Verweis statt eines eigenen Textes — und, wo es ' +
                'einen gibt, den festen Teil darunter, den nur diese Anwendung ' +
                'über sich sagen kann.'
              }
              onChange={(value) => {
                onChange({ ...document, link: value });
              }}
            />
          </div>
        ) : (
          <div className="legal-editor__fields">
            <TextSetting
              label="Eigener Text"
              value={document.custom}
              multiline
              maxLength={LEGAL_TEXT_MAX}
              issue={issues.custom}
              note={
                'Klartext. Eine Leerzeile trennt Absätze; „## " und „### " machen ' +
                'Überschriften, „- " eine Aufzählung, **Sternchenpaare** eine ' +
                'Betonung, [Beschriftung](https://…) einen Link. Alles andere ' +
                'bleibt Text — HTML wird nicht ausgewertet, sondern angezeigt.'
              }
              onChange={(value) => {
                onChange({ ...document, custom: value });
              }}
            />
          </div>
        )}

        {/*
          **Die Wahl der Fassung steht nicht an erster Stelle, sondern unter
          dem Text** (Review-Runde 3 Nr. 16). Sie stand einmal als erstes
          Bedienelement der Karte da und verlangte damit von jedem, der einen
          Rechtstext hinterlegen will, zuerst eine Entscheidung über die
          Bauform — und zwar von genau den Leuten, denen die ausformulierte Vorlage
          abgenommen werden soll.

          Sie ist nicht weg: wer einen anwaltlich geprüften Text hat, findet
          sie hier, zugeklappt hinter einem Satz, der sagt, wofür sie da ist.
          Was sich ändert, ist die Reihenfolge — der übliche Weg zuerst.

          ⚠️ **Eine Stelle und nicht zwei**, in beiden Modi dieselbe. Sie
          einmal oben (als Weg zurück) und einmal unten (als Weg hin) zu
          zeichnen, war der naheliegende Entwurf und der falsche: der Schalter
          wanderte beim Umschalten quer durch die Karte, und wer ihn gerade
          angeklickt hatte, verlor ihn unter dem Zeiger. Er bleibt jetzt, wo er
          ist; sichtbar bleibt er über {@link choiceOpen}.
        */}
        <details
          className="legal-editor__own-text"
          open={choiceOpen}
          onToggle={(event) => {
            setChoiceOpen(event.currentTarget.open);
          }}
        >
          <summary>
            {document.mode === 'template'
              ? 'Lieber einen eigenen Text oder einen Verweis hinterlegen?'
              : 'Lieber doch die Vorlage ausfüllen?'}
          </summary>
          <p className="legal-editor__note">
            Wer eine anwaltlich geprüfte Fassung hat, schreibt sie hier hin —
            dann gilt sie statt der Vorlage. Wer den Text{' '}
            <strong>schon woanders stehen hat</strong>, nennt stattdessen dessen
            Adresse: die Seite verweist dann dorthin, statt denselben Text ein
            zweites Mal zu pflegen. Beim Umschalten bleibt alles erhalten —
            ausgefüllte Vorlage, eigener Text und Adresse stehen nebeneinander,
            und es geht nichts verloren.
          </p>
          <ModeChoice
            name={modeName}
            title={template.title}
            mode={document.mode}
            onSelect={(mode) => {
              onChange({ ...document, mode });
            }}
          />
        </details>

        <details className="legal-editor__preview">
          <summary>Vorschau der ungespeicherten Fassung</summary>
          {/*
            **Der Satz sagt jetzt, worin sich Vorschau und Seite unterscheiden**
            (Review-Runde 5 Nr. 1). Seitdem ist das nämlich nicht mehr nichts:
            was hier als „Angabe fehlt: …" markiert steht, **entfällt** auf der
            veröffentlichten Seite mitsamt seiner Zeile. Ohne diesen Satz wäre
            der Unterschied die Sorte Überraschung, die man für einen Fehler
            hält.
          */}
          <p className="legal-editor__note">
            So sieht der Text aus, wenn du speicherst — mit den fehlenden
            Angaben <strong>benannt</strong>. Öffentlich entfällt jede Zeile, in
            der eine Angabe fehlt: Fremde sehen nur, was dasteht.
            {publicPath === undefined ? null : (
              <>
                {' '}
                {aiStateKnown ? null : (
                  <>
                    Abschnitte, die von der Konfiguration der Installation
                    abhängen — der Absatz zur KI —, zeigt erst die
                    veröffentlichte Seite im tatsächlichen Zustand.{' '}
                  </>
                )}
                Aufrufen:{' '}
                <a href={publicPath} rel="noreferrer">
                  veröffentlichte Seite
                </a>
                .
              </>
            )}
          </p>
          <div className="legal-text legal-editor__preview-body">
            <LegalText blocks={preview.blocks} />
          </div>
        </details>
      </div>
    </section>
  );
}

/**
 * Die Wahl zwischen Vorlage und eigenem Text.
 *
 * Ein eigener Baustein, obwohl er nur an einer Stelle steht: er trägt die
 * `radiogroup` mitsamt ihrer Beschriftung, und die gehört zusammen an einen
 * Ort statt in den Rumpf der Karte verstreut.
 */
function ModeChoice({
  name,
  title,
  mode,
  onSelect,
}: {
  readonly name: string;
  readonly title: string;
  readonly mode: LegalDocument['mode'];
  readonly onSelect: (next: LegalDocument['mode']) => void;
}): ReactElement {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={`Fassung: ${title}`}
    >
      <ModeOption
        name={name}
        label="Vorlage ausfüllen"
        selected={mode === 'template'}
        onSelect={() => {
          onSelect('template');
        }}
      />
      <ModeOption
        name={name}
        label="Eigener Text"
        selected={mode === 'custom'}
        onSelect={() => {
          onSelect('custom');
        }}
      />
      {/*
        **Der dritte Weg** (Review-Runde 5, Nachtrag): der Text steht schon auf
        einer eigenen Seite, und diese hier verweist darauf. „Verweis" und nicht
        „Weiterleitung", weil die Seite genau das tut — sie verweist, und sie
        springt nicht ungefragt auf eine fremde Adresse (`renderLegalPage`).
      */}
      <ModeOption
        name={name}
        label="Verweis auf eine Seite"
        selected={mode === 'link'}
        onSelect={() => {
          onSelect('link');
        }}
      />
    </div>
  );
}

/**
 * Der Satz unter einem Feld — der Hinweis der Vorlage, und bei einem
 * geteilten Feld der Zusatz, dass es mitläuft (Review-Runde 3 Nr. 3).
 *
 * Der Zusatz steht **hinten**: der Hinweis der Vorlage sagt, was einzutragen
 * ist, und das ist die wichtigere Auskunft. Ohne beides bleibt der Satz weg,
 * statt als leere Zeile dazustehen.
 */
export function noteFor(
  hint: string | undefined,
  shared: boolean,
): string | undefined {
  const carried = shared
    ? 'Diese Angabe steht auch in den anderen Rechtstexten dieser Ebene und wird dort mitgeführt.'
    : undefined;
  if (hint === undefined) {
    return carried;
  }
  return carried === undefined ? hint : `${hint} ${carried}`;
}

function ModeOption({
  name,
  label,
  selected,
  onSelect,
}: {
  readonly name: string;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <label
      className={
        selected
          ? 'segmented__option segmented__option--on'
          : 'segmented__option'
      }
    >
      <input
        type="radio"
        name={name}
        className="segmented__input"
        checked={selected}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}

function ConditionToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="legal-editor__condition">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <label htmlFor={id}>{label}</label>
      {hint === undefined ? null : (
        <p className="legal-editor__note" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
