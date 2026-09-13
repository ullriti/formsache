import { useId, useRef, useState, type ReactElement } from 'react';
import {
  DEFAULT_TENANT_BRANDING,
  TENANT_LOGO_HINT,
  STRIPE_COLOR_MAX,
  TENANT_LOGO_CONTENT_TYPES,
  isBrandColor,
  uploadedLogoRef,
  type DeliverableLogo,
  type TenantBrandingSettings,
  type TenantLogoRef,
} from '@formsache/shared';

import { ApiError } from '../../api/http';
import { useUploadTenantLogo } from '../../api/tenant-admin';
import { resolveTenantLogo } from '../../shell/tenant-logo';
import type { CustomPropertyStyle } from '../../styles/custom-property-style';
import type { SettingIssues } from '../settings/SettingsControls';
import type { BrandingDraft } from './tenant-admin-draft';
import { accentNotes, type ContrastNote } from './color-contrast';
import { ColorContrastNotes } from './ColorContrastNotes';
import { LogoCropDialog } from './LogoCropDialog';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * **The two cards of the appearance — Logo & Name, Colours** — as
 * pure display over somebody else's draft.
 *
 * They stood in the tab itself until ADR-0025. They are broken out because
 * since then there are **two** places at which the same fields stand: the tab
 * *Erscheinungsbild & Login* and the first step of the
 * organisation assistant (`views/tenant-setup/AppearanceStep.tsx`). That is
 * the same split `SystemMailCards` has for the instance page, and for
 * the same reason: a step of the assistant should look like the
 * setting it leads to — not similar to it.
 *
 * **They load nothing and save nothing.** Draft, refusals and the
 * saving belong to the host (`use-tenant-branding.ts`); what stands here
 * are fields. The one exception is the **logo upload**: it is not a field of the
 * document but a route of its own that takes effect at once (ADR-0014) — which is why
 * this file holds exactly that one mutation and writes its result into the
 * host's draft.
 */
export function TenantAppearanceCards({
  tenantId,
  document,
  draft,
  setDraft,
  issues,
}: {
  readonly tenantId: string;
  readonly document: TenantBrandingSettings;
  readonly draft: BrandingDraft;
  readonly setDraft: (
    next: BrandingDraft | ((previous: BrandingDraft) => BrandingDraft),
  ) => void;
  readonly issues: SettingIssues;
}): ReactElement {
  const uploadLogo = useUploadTenantLogo();

  return (
    <>
      <section className="settings-card" aria-labelledby="tenant-admin-logo">
        <header className="settings-card__head">
          <div className="settings-card__text">
            <h2 className="settings-card__heading" id="tenant-admin-logo">
              Logo &amp; Name
            </h2>
            <p className="settings-card__hint">
              Wähle eines der ausgelieferten Logos oder lade das eigene hoch.
              Ein hochgeladenes Logo ist sofort aktiv — dafür musst du nicht
              speichern.
            </p>
          </div>
        </header>
        <div className="settings-card__body">
          <LogoChoice
            choices={document.logoChoices}
            uploaded={uploadedLogoRef(document.logoRef)}
            selected={draft.logoRef}
            onSelect={(logoRef) => {
              setDraft({ ...draft, logoRef });
            }}
          />

          <LogoUpload
            isUploading={uploadLogo.isPending}
            error={uploadLogo.error}
            onPick={(file) => {
              uploadLogo.mutate(
                { tenantId, file },
                {
                  onSuccess: (saved) => {
                    // **The draft has to follow, or the next save undoes the
                    // upload.** `useServerDraft` keeps what was typed; its
                    // `logoRef` still names the previous logo, and
                    // „Speichern" would write that back over the new one —
                    // which is the same act as deleting the file that was just
                    // uploaded (`files/logo-sweep.ts`).
                    //
                    // **The updater form, not a spread of `draft`.** That
                    // spread closed over the render this handler was created
                    // in, so a colour changed while the upload was running was
                    // written back to its old value the moment the answer
                    // arrived — the colour fields are not disabled during an
                    // upload, only the file picker (the appearance-tab
                    // review).
                    setDraft((previous) => ({
                      ...previous,
                      logoRef: saved.logoRef,
                    }));
                  },
                },
              );
            }}
          />

          <div className="setting__field">
            <label className="setting__label" htmlFor="tenant-admin-name">
              Voller Name
            </label>
            <input
              className="setting__control"
              id="tenant-admin-name"
              type="text"
              value={draft.name}
              aria-invalid={issues.name === undefined ? undefined : true}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
              }}
            />
            {issues.name === undefined ? null : (
              <p className="setting__issue">{issues.name}</p>
            )}
          </div>

          <div className="setting__field">
            <span className="setting__label">Kurzname</span>
            {/*
              Read-only, deliberately not an `<input>`: renaming the Kurzname is
              a superadmin act with a uniqueness conflict of its own, not a branding change — `tenantBrandingWriteSchema` has no
              field for it, so an editable box here would promise a save this
              route refuses.
            */}
            <p className="tenant-admin__readonly">{document.shortName}</p>
          </div>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="tenant-admin-colors">
        <header className="settings-card__head">
          <div className="settings-card__text">
            <h2 className="settings-card__heading" id="tenant-admin-colors">
              Farben
            </h2>
            {/*
              The note says what each colour *does*: accent, header and
              stripe are everything that actually colours a page, and exactly
              that stands here — no example, no axis that has no effect.
            */}
            <p className="settings-card__hint">
              Die Farben deiner Organisation. Der Akzent trägt Knöpfe,
              Fortschritt und Auswahl im ganzen Programm; Kopfzeile und Streifen
              stehen über jeder Seite, die Teilnehmer zu sehen bekommen.
            </p>
          </div>
        </header>
        <div className="settings-card__body">
          <div className="tenant-admin__color-grid">
            <ColorField
              id="tenant-admin-accent"
              label="Akzent (Buttons, Fortschritt)"
              value={draft.accent}
              notes={accentNotes(draft.accent)}
              onChange={(color) => {
                setDraft({ ...draft, accent: color });
              }}
            />
            <ColorField
              id="tenant-admin-header-bg"
              label="Kopfzeilen-Hintergrund"
              value={draft.headerBg}
              onChange={(color) => {
                setDraft({ ...draft, headerBg: color });
              }}
            />
            <ColorField
              id="tenant-admin-canvas-bg"
              label="Hintergrund-Ton"
              value={draft.canvasBg}
              onChange={(color) => {
                setDraft({ ...draft, canvasBg: color });
              }}
            />
          </div>

          <StripeEditor
            colors={draft.stripeColors}
            onChange={(stripeColors) => {
              setDraft({ ...draft, stripeColors });
            }}
          />

          <BrandingPreview draft={draft} />
        </div>
      </section>
    </>
  );
}

/**
 * The Logo an organisation may pick from — **the shipped assets *and* its own upload**.
 *
 * The upload does not replace the selection, it stands next to it: „eine Organisation
 * ohne eigenes Logo soll nicht in ein Loch fallen". The tile for the uploaded
 * file appears only once there is one, and picking an asset or „Kein Logo"
 * next to it *is* the way back — the save that follows leaves the file
 * unreferenced, and the server's sweep takes it (`files/logo-sweep.ts`).
 */
function LogoChoice({
  choices,
  uploaded,
  selected,
  onSelect,
}: {
  readonly choices: readonly TenantLogoRef[];
  /** The organisation's own uploaded logo, if it has one — the server's answer. */
  readonly uploaded: string | null;
  readonly selected: DeliverableLogo;
  readonly onSelect: (logo: DeliverableLogo) => void;
}): ReactElement {
  return (
    <div
      className="tenant-admin__logo-choices"
      role="radiogroup"
      aria-label="Logo"
    >
      <LogoTile
        label="Kein Logo"
        selected={selected === null}
        onSelect={() => {
          onSelect(null);
        }}
      />
      {uploaded === null ? null : (
        <LogoTile
          label="Eigenes Logo"
          imageUrl={resolveTenantLogo({ kind: 'upload', ref: uploaded })}
          selected={selected?.kind === 'upload'}
          onSelect={() => {
            onSelect({ kind: 'upload', ref: uploaded });
          }}
        />
      )}
      {choices.map((choice) => (
        <LogoTile
          key={choice}
          label={choice}
          imageUrl={resolveTenantLogo({ kind: 'asset', ref: choice })}
          selected={selected?.kind === 'asset' && selected.ref === choice}
          onSelect={() => {
            onSelect({ kind: 'asset', ref: choice });
          }}
        />
      ))}
    </div>
  );
}

/**
 * „Eigenes Logo hochladen" — the picker, the crop step and what it is allowed
 * to send (ADR-0014 no. 5, no. 6, no. 20).
 *
 * **Nothing picked here goes straight out.** The file lands in
 * {@link LogoCropDialog}, which is where the frame is chosen and where the
 * picture is scaled down to something the 2 MiB limit accepts; only the PNG it
 * renders reaches `onPick`. The reason there is no second, uncropped path is in
 * that component's own comment — in short, the raw path is the one on which a
 * phone photo is still refused by the server for a reason the browser could
 * have removed.
 *
 * **The original is not kept** (ADR-0014 no. 20): re-cropping means
 * picking the file again.
 *
 * **The limits shown here are UX, not the check.** `accept` is switched off by
 * „Alle Dateien" in every file dialog there is, and the size is compared in a
 * browser the server does not control; both numbers come from the shared
 * constants so the caption cannot say something the server does not enforce,
 * and the server decides regardless — it reads the *content* of the file, not
 * its extension (`files/upload-pipeline.ts`).
 *
 * The refusal comes from the server whenever the server produced one:
 * `ApiError.detail` carries its own sentence — „SVG und PDF sind
 * ausgeschlossen, weil das Logo in die öffentliche Seite eingebettet wird" —
 * and inventing a second wording here would drift away from the rule it
 * describes.
 */
function LogoUpload({
  isUploading,
  error,
  onPick,
}: {
  readonly isUploading: boolean;
  readonly error: Error | null;
  readonly onPick: (file: File) => void;
}): ReactElement {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  /**
   * Where focus lands when the crop dialog closes by **confirming**.
   *
   * The dialog's opener is the file picker, and confirming starts the upload,
   * which disables it — `focus()` on a disabled control is a no-op in a browser,
   * so focus would fall to `<body>` and the next Tab would start at the top of
   * the page (the crop-dialog review; jsdom focuses it anyway, so no
   * component test sees it). The field itself survives the close and
   * carries the status line the editor now wants to hear.
   */
  const field = useRef<HTMLDivElement>(null);
  /** The picked file while its frame is being chosen — see the dialog. */
  const [picked, setPicked] = useState<File | null>(null);

  return (
    <div className="setting__field" ref={field} tabIndex={-1}>
      <label className="setting__label" htmlFor={inputId}>
        Eigenes Logo hochladen
      </label>
      <input
        ref={input}
        id={inputId}
        className="setting__control"
        type="file"
        accept={TENANT_LOGO_CONTENT_TYPES.join(',')}
        disabled={isUploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) {
            setPicked(file);
          }
          // Cleared so picking the *same* file again fires `change` — the
          // obvious thing to do after a refusal, and without this it silently
          // does nothing.
          if (input.current !== null) {
            input.current.value = '';
          }
        }}
      />
      {/* One sentence, composed in `@formsache/shared` from the same two constants
          the server applies — the arithmetic stood here by hand until the
          appearance-tab review, which is how a caption outlives the limit
          it names. */}
      <p className="setting__hint">{TENANT_LOGO_HINT}</p>
      {isUploading ? (
        <p className="setting__hint" role="status">
          Logo wird hochgeladen…
        </p>
      ) : null}
      {error === null ? null : (
        <p className="setting__issue" role="alert">
          {logoUploadMessage(error)}
        </p>
      )}
      {picked === null ? null : (
        <LogoCropDialog
          fallbackRef={field}
          file={picked}
          onCancel={() => {
            setPicked(null);
          }}
          onConfirm={(cropped) => {
            setPicked(null);
            onPick(cropped);
          }}
        />
      )}
    </div>
  );
}

/** The server's own sentence where there is one — see {@link LogoUpload}. */
function logoUploadMessage(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Diese Rolle darf das Erscheinungsbild dieser Organisation nicht ändern.';
    }
    if (error.detail !== undefined) {
      return error.detail;
    }
  }
  return 'Das Logo konnte nicht hochgeladen werden.';
}

function LogoTile({
  label,
  imageUrl,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly imageUrl?: string | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <label
      className={
        selected
          ? 'tenant-admin__logo-tile tenant-admin__logo-tile--on'
          : 'tenant-admin__logo-tile'
      }
    >
      <input
        className="tenant-admin__logo-input"
        type="radio"
        name="tenant-admin-logo"
        aria-label={label}
        checked={selected}
        onChange={onSelect}
      />
      {imageUrl === undefined ? (
        <span className="tenant-admin__logo-empty" aria-hidden="true">
          {selected ? 'kein Logo' : ''}
        </span>
      ) : (
        <img
          className="tenant-admin__logo-image"
          src={imageUrl}
          alt=""
          aria-hidden="true"
        />
      )}
    </label>
  );
}

/**
 * One colour field — and, where there are any, the message under it.
 *
 * `notes` is deliberately something the **caller** supplies rather than
 * something this field works out: only the place that sets a colour knows what
 * job that colour has. The accent ends up on buttons and in text buttons, the
 * header colour behind a name in white, the canvas behind everything — and a
 * field that invented one message for all three would be saying something wrong
 * twice over.
 */
function ColorField({
  id,
  label,
  value,
  notes = [],
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly notes?: readonly ContrastNote[];
  readonly onChange: (color: string) => void;
}): ReactElement {
  const noteId = `${id}-contrast`;

  return (
    <div className="setting__field">
      <label className="setting__label" htmlFor={id}>
        {label}
      </label>
      <span className="tenant-admin__color-input">
        <input
          id={id}
          type="color"
          className="tenant-admin__color-swatch"
          value={value}
          // The message is the description of *this* field, not a paragraph
          // beside it — otherwise only whoever stumbles over it ever hears it.
          aria-describedby={notes.length === 0 ? undefined : noteId}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        <span className="tenant-admin__color-value">{value}</span>
      </span>
      <ColorContrastNotes id={noteId} notes={notes} />
    </div>
  );
}

/**
 * The colours of the header stripe — **the organisation colours, maintained directly**.
 *
 * There is no intermediate step: no separate colour list from which a button
 * would first have to copy into the stripe. Whoever wants to change the stripe changes
 * it here, and nowhere else.
 */
function StripeEditor({
  colors,
  onChange,
}: {
  readonly colors: readonly string[];
  readonly onChange: (colors: string[]) => void;
}): ReactElement {
  return (
    <div className="tenant-admin__stripe-editor">
      <div className="tenant-admin__stripe-head">
        <span className="setting__label">
          Organisationsfarben im Header-Streifen (Farben &amp; Reihenfolge)
        </span>
      </div>

      <p className="setting__hint">
        Die Farben und ihre Reihenfolge bestimmst du hier; sie erscheinen im
        Kopfstreifen jeder Seite, die deine Organisation Teilnehmern zeigt.
      </p>

      <StripePreviewBar colors={colors} />

      <div className="tenant-admin__stripe-items">
        {colors.map((color, index) => (
          <div
            // Entries have no identity of their own besides their position in
            // the order.
            key={index}
            className="tenant-admin__stripe-item"
          >
            <input
              type="color"
              className="tenant-admin__color-swatch tenant-admin__color-swatch--stripe"
              // The three fields above (`ColorField`) carry a visible
              // `<label htmlFor>`; these do not, because the visible text of
              // this editor names the *stripe*, not its parts. Without a name
              // of their own they were controls a screen reader announces as
              // „Farbe" three times over — which of the three is being changed
              // is exactly what an editor cannot see here. The position is the
              // only identity a stripe colour has (see the `key` above), so it
              // is what the name says.
              aria-label={`Streifenfarbe ${String(index + 1)} von ${String(colors.length)}`}
              value={color}
              onChange={(event) => {
                const next = [...colors];
                next[index] = event.target.value;
                onChange(next);
              }}
            />
            <span className="tenant-admin__stripe-actions">
              <button
                type="button"
                className="tenant-admin__stripe-move"
                disabled={index === 0}
                // Same reason as the swatch above: three buttons called „Nach
                // links verschieben" are three controls a screen reader cannot
                // tell apart.
                aria-label={`Streifenfarbe ${String(index + 1)} nach links verschieben`}
                onClick={() => {
                  const next = [...colors];
                  const [item] = next.splice(index, 1);
                  if (item !== undefined) {
                    next.splice(index - 1, 0, item);
                  }
                  onChange(next);
                }}
              >
                ◀
              </button>
              <button
                type="button"
                className="tenant-admin__stripe-move"
                disabled={index === colors.length - 1}
                aria-label={`Streifenfarbe ${String(index + 1)} nach rechts verschieben`}
                onClick={() => {
                  const next = [...colors];
                  const [item] = next.splice(index, 1);
                  if (item !== undefined) {
                    next.splice(index + 1, 0, item);
                  }
                  onChange(next);
                }}
              >
                ▶
              </button>
              <button
                type="button"
                className="tenant-admin__stripe-remove"
                disabled={colors.length <= 1}
                aria-label={`Streifenfarbe ${String(index + 1)} entfernen`}
                onClick={() => {
                  onChange(colors.filter((_, at) => at !== index));
                }}
              >
                ×
              </button>
            </span>
          </div>
        ))}
        <button
          type="button"
          className="tenant-admin__stripe-add"
          disabled={colors.length >= STRIPE_COLOR_MAX}
          onClick={() => {
            // A starting point for a colour the editor is about to pick —
            // the organisation's own accent, never a literal (`CONTRIBUTING.md`).
            onChange([...colors, DEFAULT_TENANT_BRANDING.accent]);
          }}
        >
          + Farbe
        </button>
      </div>
    </div>
  );
}

function stripeStyle(colors: readonly string[]): CustomPropertyStyle {
  if (colors.length === 0 || !colors.every(isBrandColor)) {
    return {};
  }
  const segment = 100 / colors.length;
  const stops = colors.map(
    (color, index) =>
      `${color} ${(segment * index).toFixed(2)}% ${(segment * (index + 1)).toFixed(2)}%`,
  );
  return {
    '--tenant-admin-stripe': `linear-gradient(90deg, ${stops.join(', ')})`,
  };
}

function StripePreviewBar({
  colors,
}: {
  readonly colors: readonly string[];
}): ReactElement {
  return (
    <div className="tenant-admin__stripe-bar" style={stripeStyle(colors)} />
  );
}

function BrandingPreview({
  draft,
}: {
  readonly draft: BrandingDraft;
}): ReactElement {
  const style: CustomPropertyStyle = {
    ...stripeStyle(draft.stripeColors),
    ...(isBrandColor(draft.headerBg)
      ? { '--tenant-admin-header-bg': draft.headerBg }
      : {}),
    ...(isBrandColor(draft.accent)
      ? { '--tenant-admin-accent': draft.accent }
      : {}),
  };
  const logoUrl = resolveTenantLogo(draft.logoRef);

  return (
    <div className="tenant-admin__preview">
      <p className="setting__label">Live-Vorschau</p>
      <div className="tenant-admin__preview-frame" style={style}>
        <div className="tenant-admin__preview-stripe" />
        <div className="tenant-admin__preview-header">
          <span className="tenant-admin__preview-mark">
            {logoUrl === undefined ? (
              'Logo'
            ) : (
              <img
                src={logoUrl}
                alt=""
                className="tenant-admin__preview-logo"
              />
            )}
          </span>
          <span className="tenant-admin__preview-name">{draft.name}</span>
        </div>
        <div className="tenant-admin__preview-body">
          <span className="tenant-admin__preview-bar" />
          <button
            type="button"
            className="tenant-admin__preview-button"
            disabled
          >
            Weiter ›
          </button>
        </div>
      </div>
    </div>
  );
}
