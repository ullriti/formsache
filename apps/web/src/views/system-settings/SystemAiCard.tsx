import type { ReactElement } from 'react';
import {
  AI_MODEL_CHOICES,
  AI_PRECONDITIONS,
  AI_REGION_DEFAULT,
  DEFAULT_AI_MODEL,
  type AiProvider,
  type AiRegion,
  type SystemAiSettings,
} from '@formsache/shared';

import {
  SelectSetting,
  TextSetting,
  ToggleSetting,
  type SelectSettingOption,
} from '../settings/SettingsControls';
import type { SystemAiDraft } from './system-ai-draft';

import '../settings-view.css';
import './system-ai-settings.css';

/**
 * **The card *KI-Anbieter*** — pure and controlled, like the three cards of the
 * mail tab (`SystemMailCards.tsx`).
 *
 * It stands at **two** places: in the tab *KI* of the system administration and
 * as step 6 of the setup assistant. That is the whole reason why it is a file of
 * its own — and the reason why it knows no loading, no saving and no route: what
 * happens with the draft is decided by the place at which it stands.
 *
 * ## Since 2026-08-18 the construction is the shared one (ADR-0022, extension)
 *
 * This tab was the one that did **not** use the shared building blocks: own
 * classes (`settings__card`, `system-ai__field`), handwritten select fields,
 * five loose `useState` instead of one draft and an own save button instead of
 * `SettingsSaveBar`. It thereby looked different from the mail tab next to it —
 * and in the assistant, which shows both one after the other, that would have
 * been visible as patchwork immediately.
 *
 * **A behaviour change comes along with that, and it is intended:** the save bar
 * of the tab blocks „Speichern" as long as nothing is changed, and says
 * „Gespeichert"/„Nicht gespeichert" — exactly like every other settings page.
 * Before, the button always worked and sent a round even when it had nothing to
 * say.
 */

/** What stands in the select field — the two providers plus „keiner". */
const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  mistral: 'Mistral',
};

/**
 * The three regions — **short**, because a `select` measures itself by its
 * longest option and not by its box.
 *
 * The first version carried the explanation in the options themselves („EU
 * (api.eu.mistral.ai) — Verarbeitung in der EU, Vorgabe"); at 360 px the field
 * thereby stood 89 px beyond the edge. What a change **means** therefore stands
 * in the note under the field — on the spot, but not in the control.
 */
const REGION_LABELS: Record<AiRegion, string> = {
  eu: 'EU (Vorgabe)',
  global: 'Global',
  us: 'USA',
};

const REGION_OPTIONS: readonly SelectSettingOption[] = (
  Object.keys(REGION_LABELS) as AiRegion[]
).map((value) => ({ value, label: REGION_LABELS[value] }));

const REGION_NOTE =
  `Die Region entscheidet, wo der Anbieter gerufen wird — Vorgabe ist ${AI_REGION_DEFAULT} ` +
  '(Mistral über api.eu.mistral.ai). „Global" und „USA" verarbeiten außerhalb der EU und ' +
  'berühren die Drittlandfrage des Verarbeitungsverzeichnisses; sie brauchen eine eigene ' +
  'Rechtsgrundlage. Anthropic verarbeitet unabhängig von diesem Feld außerhalb der EU.';

/**
 * Only **one** entry left: `'model'` fell away on 2026-08-12, when every
 * provider got a default value — a half configuration has been the one without
 * a key ever since (`describeAiConfigGap`).
 */
const GAP_MESSAGES: Record<'apiKey', string> = {
  apiKey:
    'Es ist ein Anbieter gewählt, aber kein Schlüssel hinterlegt. Die ' +
    'Funktion bleibt so lange abwesend — die Anwendung läuft normal weiter.',
};

export interface SystemAiCardProps {
  readonly draft: SystemAiDraft;
  readonly setDraft: (next: SystemAiDraft) => void;
  /** The **stored** document — for "already set up?" and `apiKeySet`. */
  readonly stored: SystemAiSettings;
  /** Which field a half configuration still needs, or `null`. */
  readonly gap: 'apiKey' | null;
}

export function SystemAiCard({
  draft,
  setDraft,
  stored,
  gap,
}: SystemAiCardProps): ReactElement {
  /**
   * **The moment before the first call to a foreign provider** — not at the
   * second saving.
   *
   * So it is shown as soon as a provider stands in this form where none stood
   * in the stored row. Only at the saving would be too late: by then the
   * operator has already taken the decision.
   */
  const firstProviderChoice =
    stored.provider === null && draft.provider !== null;

  /**
   * **The choice belongs to the provider** — `claude-opus-5` under Mistral is
   * not a half-right value but a 404 at the first draft.
   */
  const choices =
    draft.provider === null ? [] : AI_MODEL_CHOICES[draft.provider];
  const fallbackModel =
    draft.provider === null ? undefined : DEFAULT_AI_MODEL[draft.provider];
  /**
   * **A stored value that the list does not carry stays selectable.**
   *
   * Two ways lead here: an installation from the free-text era, and a model the
   * provider has deprecated in the meantime. In both cases it would be the
   * wrong thing to pull the value quietly onto the default at the next saving —
   * the operator would thereby change their running model because they touched
   * the region. The entry therefore stands along with the others and is marked
   * as being outside the list.
   */
  const unlistedModel =
    // **Only with a chosen provider.** Without one `resolveAiConfig` resolves
    // to `null` — the note „es wird weiter benutzt" would then be plainly
    // wrong, and nothing at all would be used.
    draft.provider !== null &&
    draft.model !== '' &&
    !choices.some((choice) => choice.id === draft.model)
      ? draft.model
      : null;

  const modelOptions: readonly SelectSettingOption[] = [
    {
      value: '',
      label:
        draft.provider === null
          ? 'Erst einen Anbieter wählen'
          : fallbackModel === undefined
            ? 'Keine Vorgabe hinterlegt'
            : `Vorgabe (${fallbackModel})`,
    },
    ...choices.map((choice) => ({ value: choice.id, label: choice.label })),
    ...(unlistedModel === null
      ? []
      : [
          {
            value: unlistedModel,
            label: `${unlistedModel} (nicht in der Liste)`,
          },
        ]),
  ];

  return (
    <section className="settings-card" aria-labelledby="system-ai-heading">
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="system-ai-heading">
            KI-Anbieter
          </h2>
          <p className="settings-card__hint">
            Diese Werte standen früher in der <code>.env</code>. Sie stehen
            jetzt hier, damit sie ohne Neustart änderbar sind — der Schlüssel
            liegt verschlüsselt in der Datenbank und verlässt den Server nie.
          </p>
          {/*
            **Der Verweis auf die Wissensbasis steht hier — und immer**
            (Review-Runde 5, Nachtrag, nachgeschärft nach dem Review).

            Er stand zuerst im Einrichtungsassistenten, in einem Absatz über
            dieser Karte, und damit an der einen Stelle, an der diese Karte
            *nicht* die einzige ist: der Reiter *KI* hatte ihn gar nicht. Beim
            Umzug hing er kurz an den fünf Vorbedingungen — die erscheinen aber
            nur im Augenblick der **ersten** Anbieterwahl, und damit sah ihn
            eine Installation mit gespeichertem Anbieter nie wieder. Er gehört
            an die Karte selbst: die Vorbedingungen gelten weiter, auch wenn
            gerade niemand etwas umstellt.
          */}
          <p className="settings-card__hint">
            Vor dem Einschalten gelten datenschutzrechtliche Vorbedingungen. Sie
            stehen in Kurzform an dieser Karte, sobald du einen Anbieter wählst,
            und ausführlich im Datenschutzkapitel der Wissensbasis (
            <code>docs/kb/10-datenschutz.md</code>, §4).
          </p>
        </div>
      </header>

      {gap === null ? null : (
        <p className="settings-card__notice" role="status">
          <span aria-hidden="true">ⓘ </span>
          {GAP_MESSAGES[gap]}
        </p>
      )}

      <div className="settings-card__body">
        <SelectSetting
          label="Anbieter"
          value={draft.provider ?? ''}
          options={[
            { value: '', label: 'Keiner (Funktion abwesend)' },
            ...(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((value) => ({
              value,
              label: PROVIDER_LABELS[value],
            })),
          ]}
          onChange={(value) => {
            const provider = value === '' ? null : (value as AiProvider);
            setDraft({
              ...draft,
              provider,
              /*
               * **And the model back to the default** — the identifiers of the
               * two providers are completely different; leaving an Anthropic
               * value standing under Mistral would mean saving a configuration
               * that only fails at the first draft.
               *
               * ⚠️ **Back to the stored value as soon as one lands at the
               * stored provider** (review rework, 2026-08-12). Whoever switched
               * the provider by mistake and **switched it back** otherwise
               * wrote `model: null` at the next saving — and thereby pulled
               * away precisely the old free-text identifier that the escape
               * hatch below is meant to preserve. The note about it had already
               * disappeared at this moment, so they would not even have seen
               * it.
               */
              model: provider === stored.provider ? (stored.model ?? '') : '',
            });
          }}
        />

        {firstProviderChoice ? (
          <section className="system-ai__preconditions" role="note">
            <strong>
              Bevor du einen Anbieter einschaltest — fünf Vorbedingungen:
            </strong>
            <ol>
              {AI_PRECONDITIONS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </section>
        ) : null}

        {/*
        **A select, not a text field** (addendum to ADR-0015 no. 5,
        2026-08-12). A mistyped `claude-opus-4` was saved without objection
        until then and only came out at the first form draft — as a 404 of the
        provider, at a place where nobody thinks of this field any more. The
        list stands in `@formsache/shared`, so that it is the same one
        `resolveAiConfig` and the tests measure against.
      */}
        <SelectSetting
          label="Modell"
          value={draft.model}
          options={modelOptions}
          disabled={draft.provider === null}
          onChange={(model) => {
            setDraft({ ...draft, model });
          }}
        />
        {unlistedModel === null ? null : (
          <p className="settings__note" role="status">
            Das hinterlegte Modell <code>{unlistedModel}</code> steht nicht in
            der Auswahl — es wird weiter benutzt und bleibt beim Speichern
            erhalten. Das ist normal für eine Installation, die vor dieser
            Fassung eingerichtet wurde. Antwortet der Anbieter darauf mit einem
            Fehler, ist die Kennung abgekündigt: dann hier ein anderes Modell
            wählen.
          </p>
        )}

        <SelectSetting
          label="Region"
          value={draft.region}
          options={REGION_OPTIONS}
          note={REGION_NOTE}
          onChange={(region) => {
            setDraft({ ...draft, region: region as AiRegion });
          }}
        />

        <TextSetting
          label="API-Schlüssel"
          value={draft.newApiKey}
          variant="mono"
          type="password"
          placeholder={
            stored.apiKeySet
              ? 'Hinterlegt — leer lassen, um ihn zu behalten'
              : 'Kein Schlüssel hinterlegt'
          }
          note={
            'Der gespeicherte Schlüssel steht hier nie. Leer lassen heißt „den hinterlegten behalten".'
          }
          onChange={(newApiKey) => {
            setDraft({ ...draft, newApiKey });
          }}
        />

        <ToggleSetting
          title="KI-Formularerstellung zulassen"
          description="Gilt für diese Installation; Organisationen können sich zusätzlich selbst abschalten."
          checked={draft.enabled}
          onChange={(enabled) => {
            setDraft({ ...draft, enabled });
          }}
        />
      </div>
    </section>
  );
}
