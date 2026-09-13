import type { ReactElement, ReactNode } from 'react';

import { TextSetting } from '../settings/SettingsControls';
import type { TenantAddressFieldState } from './use-tenant-addresses';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * **The two address cards** — base address and reply-to address, as pure
 * display over a foreign field state (`use-tenant-addresses.ts`).
 *
 * Two hosts since ADR-0025: the *Mailversand* tab, where under each card
 * its own save bar stands, and the third step of the
 * organization wizard, where both cards stand one below the other and one
 * button saves both. The cards know nothing of either.
 *
 * `footer` is there for exactly that and is deliberately a place **inside** the card:
 * the save bar always stood there, and hanging it next to it would be
 * a shift in the picture for a reordering in the source.
 */

interface AddressCardProps {
  readonly field: TenantAddressFieldState;
  /** What stands under the field in the card — the save bar, or nothing. */
  readonly footer?: ReactNode;
}

export function TenantBaseUrlFields({
  field,
  footer,
  prefillNote,
}: AddressCardProps & {
  /**
   * Ein Satz zur Vorbelegung, oder nichts (Review-Runde 3 Nr. 5).
   *
   * Nur der Einrichtungsassistent setzt ihn: dort ist das Feld mit der
   * Adresse vorbelegt, unter der die Seite gerade aufgerufen wurde, und ein
   * vorbelegter Wert ohne Erklärung ist ein Wert, den man für gespeichert
   * hält.
   */
  readonly prefillNote?: string;
}): ReactElement {
  return (
    <section
      className="settings-card"
      aria-labelledby="tenant-admin-base-url-heading"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2
            className="settings-card__heading"
            id="tenant-admin-base-url-heading"
          >
            Basis-Adresse
          </h2>
          <p className="settings-card__hint">
            Gilt für die Links, die an Teilnehmer gehen — etwa den
            Bearbeiten-Link in einer Bestätigungsmail. Nicht für die Anmeldung:
            die bleibt auf der Adresse der Installation, sonst gälte das
            Sitzungs-Cookie nach dem Login nicht mehr.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <TextSetting
          label="Basis-Adresse"
          value={field.value}
          placeholder="https://formulare.example.org"
          variant="mono"
          issue={field.issue}
          onChange={field.setValue}
        />
        {prefillNote === undefined ? null : (
          <p className="tenant-admin__readonly">{prefillNote}</p>
        )}
        <p className="tenant-admin__readonly">
          Leer lassen, damit die Systemvorgabe gilt. Fehlt auch die, bleibt ein
          Bearbeiten-Link in einer Mail unaufgelöst, statt auf eine geratene
          Adresse zu zeigen.
        </p>
      </div>
      {footer}
    </section>
  );
}

export function TenantReplyToFields({
  field,
  footer,
}: AddressCardProps): ReactElement {
  return (
    <section
      className="settings-card"
      aria-labelledby="tenant-admin-reply-to-heading"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2
            className="settings-card__heading"
            id="tenant-admin-reply-to-heading"
          >
            Antwortadresse
          </h2>
          <p className="settings-card__hint">
            Wohin Antworten auf die Mails dieser Organisation gehen sollen. Eine
            einzelne Benachrichtigung kann eine eigene hinterlegen; diese hier
            gilt für alle übrigen.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        <TextSetting
          label="Antwortadresse"
          value={field.value}
          placeholder="geschaeftsstelle@example.org"
          variant="mono"
          issue={field.issue}
          onChange={field.setValue}
        />
        <p className="tenant-admin__readonly">
          Leer lassen, damit die Systemvorgabe gilt. Fehlt auch die, trägt die
          Mail keine Antwortadresse – eine Antwort geht dann an die
          Absenderadresse.
        </p>
      </div>
      {footer}
    </section>
  );
}
