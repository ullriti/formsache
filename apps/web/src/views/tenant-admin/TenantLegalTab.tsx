import type { ReactElement } from 'react';
import {
  applySharedFills,
  sharedSlotKeys,
  TENANT_LEGAL_PAGES,
  TENANT_LEGAL_TEMPLATES,
  tenantLegalPath,
  type LegalRenderContext,
  type TenantLegalPages,
} from '@formsache/shared';

import { issuesUnder } from '../api-messages';
import { LegalPageEditor } from '../legal/LegalPageEditor';
import type { SettingIssues } from '../settings/SettingsControls';
import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { useTenantLegalPages } from './use-tenant-legal';

import '../settings-view.css';

/**
 * Welche Felder dieser Ebene in beiden Seiten stehen — einmal berechnet, aus
 * den Vorlagen abgeleitet. Siehe `SystemLegalTab` für dieselbe Konstante eine
 * Ebene höher.
 */
const SHARED_TENANT_SLOTS = sharedSlotKeys(
  Object.values(TENANT_LEGAL_TEMPLATES),
);

/**
 * *Rechtstexte* — provider details and privacy notices of this organisation
 * (ADR-0028).
 *
 * ## Why this organisation needs its own
 *
 * Because the roles fall apart: it is the **controller** for the answers that
 * come in through its forms (Art. 4 no. 7 GDPR), and only it knows purpose,
 * legal basis and retention period. The privacy policy of the operator cannot
 * fulfil this duty to inform — it knows the answers to none of the three
 * questions (`docs/legal/README.md` section 2.3).
 *
 * ## What is fixed here
 *
 * The technical part of the privacy notices — what the software does with the
 * data, how long it keeps it, who can see it. It is the same for every
 * organisation and verifiable, and an organisation that could change it could
 * assert something untrue about a piece of software it does not control. It
 * stands in the preview as well, but it is not a field.
 */
export function TenantLegalTab({
  tenantId,
  tenantName,
  tenantShortName,
}: {
  readonly tenantId: string;
  readonly tenantName: string;
  /**
   * The short name — it sits in the addresses of the two public pages
   * (`/o/<kurzname>/…`) and thereby in the preview and in the link
   * „veröffentlichte Seite".
   */
  readonly tenantShortName: string;
}): ReactElement {
  const state = useTenantLegalPages(tenantId);

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        Rechtstexte werden geladen…
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p className="settings__state" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <>
      <TenantLegalCards
        pages={state.pages}
        tenantName={tenantName}
        tenantShortName={tenantShortName}
        issues={state.issues}
        onChange={state.setPages}
      />

      <SettingsSaveBar
        isSaving={state.isSaving}
        dirty={state.dirty}
        onSave={() => {
          state.save(() => undefined);
        }}
      />

      {state.errorMessage === null ? null : (
        <p className="settings__alert" role="alert">
          {state.errorMessage}
        </p>
      )}
    </>
  );
}

/** The two cards — used by the initial setup as well (ADR-0025). */
export function TenantLegalCards({
  pages,
  tenantName,
  tenantShortName,
  issues = {},
  onChange,
}: {
  readonly pages: TenantLegalPages;
  readonly tenantName: string;
  readonly tenantShortName: string;
  /**
   * The field messages of a refused write, **under the paths of the request**
   * (`pages.<seite>.…`) — ADR-0028 no. 9.
   *
   * Each card shortens its own prefix below, and that is the whole reason the
   * shortening does not happen in `fieldIssues`: two documents stand here at
   * the same time, and `pages.imprint.custom` and `pages.privacy.custom` would
   * otherwise both arrive as `custom` and mark both cards
   * ({@link issuesUnder}).
   */
  readonly issues?: SettingIssues;
  readonly onChange: (next: TenantLegalPages) => void;
}): ReactElement {
  /**
   * `operatorName: null` in the preview, and that is honest rather than
   * convenient: the name of the operator stands in the imprint of the
   * **installation**, and this organisation may not read the system row. The
   * preview therefore shows a named gap at this place — on the published page
   * the name stands as soon as the operator has stored it.
   */
  const context: LegalRenderContext = {
    organisationName: tenantName,
    organisationShortName: tenantShortName,
    operatorName: null,
    aiActive: false,
    /*
      `redirectTarget: null` for the same reason, and it is not a gap here:
      an organisation has no single redirect target — several of its forms
      have several —, and the block about it on this page names none. Where
      the answer *is* single, the notice of one form, the application fills it
      in itself (ADR-0028 Nr. 5).
    */
    redirectTarget: null,
  };

  return (
    <>
      {/*
        Dieselbe Orientierung wie eine Ebene höher (Review-Runde 3 Nr. 16),
        mit dem Unterschied, auf den es hier ankommt: eine Organisation
        beantwortet **nicht** dieselben Fragen wie der Betrieb. Sie ist
        verantwortliche Stelle für die Antworten, die über ihre Formulare
        hereinkommen — der Betrieb ist Diensteanbieter für die Seite, auf der
        das geschieht.
      */}
      <section className="settings-card" aria-labelledby="tenant-legal-lead">
        <header className="settings-card__head">
          <div className="settings-card__text">
            <h2 className="settings-card__heading" id="tenant-legal-lead">
              Was hier auszufüllen ist
            </h2>
            <p className="settings-card__hint">
              Zwei Seiten, verlinkt aus der Fußzeile jedes Formulars dieser
              Organisation. Die <strong>Anbieterangaben</strong> sagen, wer ihr
              seid; die <strong>Datenschutzhinweise</strong> sagen, was mit den
              Angaben der Teilnehmenden geschieht. Beides braucht ihr, sobald
              ein Formular veröffentlicht ist — die Angaben des Betriebs
              ersetzen sie nicht, denn verantwortlich für die Antworten seid
              ihr.
            </p>
            <p className="settings-card__hint">
              Der übliche Weg ist die Vorlage: sie ist ausformuliert, und was
              fehlt, sind <strong>Felder</strong>. Anschrift, Telefonnummer und
              die Angaben zum Datenschutzbeauftragten stehen in beiden Seiten —
              tippt sie <strong>einmal</strong>, sie werden mitgeführt.
            </p>
            {/*
              Derselbe Hinweis wie in der Systemverwaltung, aus demselben
              Grund (Review-Runde 4 Nr. 9) — hier sogar zwingender: der Text
              wird von einer **fremden** Organisation veröffentlicht, und der
              Betrieb der Installation stellt ihr nur die Vorlage hin.
            */}
            <p className="settings-card__hint">
              <strong>Keine Rechtsberatung.</strong> Die Vorlage ist ein
              ausformulierter Entwurf und keine geprüfte Fassung: ob sie für
              eure Organisation vollständig und richtig ist, entscheidet, wer
              den Fall kennt. Verantwortlich für den veröffentlichten Text seid
              ihr.
            </p>
          </div>
        </header>
      </section>

      {TENANT_LEGAL_PAGES.map((page) => (
        <LegalPageEditor
          key={page}
          template={TENANT_LEGAL_TEMPLATES[page]}
          document={pages[page]}
          context={context}
          publicPath={tenantLegalPath(tenantShortName, page)}
          issues={issuesUnder(issues, `pages.${page}.`)}
          sharedSlots={SHARED_TENANT_SLOTS}
          onChange={(next) => {
            // Anschrift, Telefonnummer und der Datenschutzbeauftragte stehen
            // in beiden Seiten — siehe `applySharedFills` (Review-Runde 3
            // Nr. 3).
            onChange(
              applySharedFills(pages, TENANT_LEGAL_TEMPLATES, page, next),
            );
          }}
        />
      ))}
    </>
  );
}
