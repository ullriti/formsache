import { useId, type ReactElement } from 'react';
import {
  LICENCES_PATH,
  systemLegalPath,
  tenantLegalPath,
  type PublicFormPrivacyNotice,
} from '@formsache/shared';

import { usePublicLegalFooter } from '../api/legal';
import { ProductCopyright } from '../brand/ProductCopyright';
import { LegalText } from '../views/legal/LegalText';

import '../views/legal/legal.css';
import './public-legal-footer.css';

/**
 * **The footer under every public view** — two origins,
 * labelled (ADR-0028, `docs/legal/README.md` 5.3).
 *
 * ## Why two blocks and not one
 *
 * Because two legal layers lie on top of each other and the participating person
 * cannot tell them apart: the **organisation** is the controller for
 * the data they are about to enter (Art. 4 Nr. 7 DSGVO), the **operator** is
 * the service provider for the page on which they do it (§ 5 DDG, § 18 MStV). And
 * via `tenant.public_base_url` an organisation can run under its *own* address
 * and is then the service provider itself — only the labelled double
 * display holds true under both addresses.
 *
 * ## The label is the achievement, not the link
 *
 * „Impressum | Impressum" side by side is **worse** than one: the
 * participating person then cannot tell whom to turn to with a
 * request for information — and Art. 13 Abs. 1 lit. a demands exactly that
 * recognisability. Hence „Verantwortlich für dieses Formular" against „Betrieb
 * dieser Plattform".
 *
 * ## The order: organisation first
 *
 * It is the controller for the data that is about to be collected; the
 * operator is the sideshow for the participating person. If the
 * installation runs under the organisation's address, it is additionally the
 * service provider — the order then holds doubly.
 *
 * ## The link stands **always**, without exception
 *
 * Even when nothing is deposited. A missing link would make the deficiency
 * invisible: the operator would never notice they had forgotten something, the
 * organisation neither, and the participating person would have no
 * clue whom to turn to. A missing imprint is a violation with or
 * without a link — **only with a link is it remediable**
 * (`docs/legal/README.md` 5.4). The page behind it then tells the truth.
 *
 * Die eine Ausnahme, die hier einmal stand, ist mit ihrer Seite fort: die
 * Erklärung zur Barrierefreiheit erschien nur, wenn sie ausgefüllt war, und
 * ist seit Review-Runde 4 Nr. 4 ersatzlos gestrichen. Damit sind alle drei
 * Verweise unbedingt.
 *
 * ## Accessibility
 *
 * A `<footer>` with `<nav aria-label="Rechtliche Angaben">`: the footer is
 * navigation and needs a name, otherwise somebody with a screen reader hears „nav"
 * beside the form navigation and does not know which is which. The two
 * blocks are two lists with one heading each, so that the assignment holds
 * even when the arrangement cannot be seen.
 *
 * ## The form's privacy notice stands **above** everything
 *
 * ADR-0028 no. 4: purpose and legal basis are to be stated **per processing**
 * under Art. 13 Abs. 1 lit. c, and a form is one processing. The
 * form-specific notice therefore stands as the first block of this footer,
 * immediately above the label „Verantwortlich für dieses Formular" and
 * the link to the organisation's general privacy notices — from the
 * particular to the general, in the order in which it is meant to be
 * read.
 *
 * **Why here and not above the questions.** Because `FillIn` renders the form and the
 * confirmation page in the same frame: a block above the questions
 * would vanish on submission, and „er erscheint nicht auf der
 * Bestätigungsseite" is exactly one of the deficiencies with which ADR-0028 no. 4 rejects
 * the makeshift via the question type `info`. Here it stands under the form,
 * under the confirmation page, under the availability notice, under the
 * edit view and under the resumed draft — five views,
 * one decision.
 *
 * **The sixth, the locked preliminary stage, does not get it**, and that is
 * no gap: `lockedPublicFormSchema` carries the title and the organisation and
 * nothing else. Before the access word nothing is collected, the notice stands
 * on the same page as the first input field — and delivering it before that
 * would mean handing out the declared purpose of a protected form to
 * anybody who has the address. The route to the organisation's general
 * privacy notices stands there all the same.
 *
 * **And why no page of its own.** A form is reachable only via its slug,
 * and that is an access feature from the CSPRNG; a
 * legal document under an unguessable address contradicts „ständig
 * verfügbar" (ADR-0028 no. 1). The permanently reachable address therefore
 * remains `/o/<kurzname>/privacy`, and it stands unchanged one paragraph
 * further down.
 */
export function PublicLegalFooter({
  organisation,
  privacyNotice,
}: {
  /**
   * The organisation whose page is currently open — or `undefined` on
   * a page that belongs to none (the installation's imprint, say).
   *
   * `name` is optional because not every view has it to hand: an
   * organisation's legal-text page knows only the short name from the
   * address. Without a name the label stands on its own, which is true — guessing
   * the name would not be.
   */
  readonly organisation?: {
    readonly shortName: string;
    readonly name?: string;
  };
  /**
   * The privacy notice of **this form**, rendered by the server — or
   * `undefined`/`null` when none is deposited.
   *
   * Blocks and not a string: the decision about what structure a
   * legal text may have was made on the server
   * (`packages/shared/src/legal-text.ts`), and this view has nothing it
   * could hand to a `dangerouslySetInnerHTML` (ADR-0028 section 7).
   *
   * If it is missing, **nothing** stands here — no substitute text and no error message.
   * The organisation's general privacy notices stand one link
   * further and may suffice for this form; „hier fehlt etwas" would be
   * a message to exactly the organisation at which nothing is missing.
   */
  readonly privacyNotice?: PublicFormPrivacyNotice | null;
}): ReactElement {
  const footer = usePublicLegalFooter();
  const installationName = footer.data?.installationName ?? null;
  /*
    `useId` and no fixed identifiers: the footer does stand once per page
    today, but a duplicated `id` in the document is the defect nobody
    sees and that makes `aria-labelledby` point at the first occurrence —
    that is, at the wrong list.
  */
  const organisationLabelId = useId();
  const installationLabelId = useId();
  const noticeLabelId = useId();

  return (
    <footer className="legal-footer">
      {privacyNotice === undefined || privacyNotice === null ? null : (
        /*
          A `<section>` and not part of the `<nav>`: this here is text one
          reads, and no navigation. It carries its heading via
          `aria-labelledby` so that it has a name in the landmark list.
        */
        <section
          className="legal-footer__notice"
          aria-labelledby={noticeLabelId}
        >
          <h2 className="legal-footer__label" id={noticeLabelId}>
            {privacyNotice.title}
          </h2>
          {/*
            **Hier stand der Warnhinweis „Diese Angaben sind unvollständig."**
            Entfallen mit Review-Runde 5 Nr. 1, zusammen mit den markierten
            Lücken im Hinweis selbst: was fehlt, sieht die Organisation im
            Formularentwurf und beim Veröffentlichen — der Zustand reist zu
            einer ausfüllenden Person gar nicht mehr mit
            (`publicFormPrivacyNoticeSchema`).
          */}
          <div className="legal-text legal-footer__notice-body">
            <LegalText blocks={privacyNotice.blocks} />
          </div>
        </section>
      )}

      <nav className="legal-footer__nav" aria-label="Rechtliche Angaben">
        {organisation === undefined ? null : (
          <div className="legal-footer__group">
            {/*
              **Der Name steht in einer eigenen Zeile** (Review-Runde 3
              Nr. 8). Vorher hing er mit Doppelpunkt an der Beschriftung, und
              die Beschriftung ist versal gesetzter Kleindruck: „VERANTWORTLICH
              FÜR DIESES FORMULAR: ARBEITSGEMEINSCHAFT DER …" hat auf keiner
              Breite Platz, und was umbricht, bricht mitten im Namen um.

              Zwei Elemente statt eines `<br>`: der Name ist eine andere
              Aussage als die Beschriftung — er darf größer, dunkler und nicht
              versal sein —, und ein Umbruch, der nur aus einem Zeilenwechsel
              besteht, überlebt keine Änderung am Satz.
            */}
            <h2 className="legal-footer__label" id={organisationLabelId}>
              <span className="legal-footer__label-text">
                Verantwortlich für dieses Formular
              </span>{' '}
              {organisation.name === undefined ? null : (
                <span className="legal-footer__owner">{organisation.name}</span>
              )}
            </h2>
            <ul
              className="legal-footer__links"
              aria-labelledby={organisationLabelId}
            >
              <li>
                <a href={tenantLegalPath(organisation.shortName, 'imprint')}>
                  Anbieterangaben
                </a>
              </li>
              <li>
                <a href={tenantLegalPath(organisation.shortName, 'privacy')}>
                  Datenschutzhinweise
                </a>
              </li>
            </ul>
          </div>
        )}

        <div className="legal-footer__group">
          <h2 className="legal-footer__label" id={installationLabelId}>
            <span className="legal-footer__label-text">
              Betrieb dieser Plattform
            </span>{' '}
            {installationName === null ? null : (
              <span className="legal-footer__owner">{installationName}</span>
            )}
          </h2>
          <ul
            className="legal-footer__links"
            aria-labelledby={installationLabelId}
          >
            <li>
              <a href={systemLegalPath('imprint')}>Impressum</a>
            </li>
            <li>
              <a href={systemLegalPath('privacy')}>Datenschutz</a>
            </li>
            <li>
              <a href={LICENCES_PATH}>Lizenzen</a>
            </li>
          </ul>
        </div>
      </nav>

      {/*
        Der Urheberrechtsvermerk — **der der Software**, nicht der des
        Betreibers. Er steht seit Review-Runde 3 (Nr. 9, 10, 15) in einem
        eigenen Baustein, weil er nicht nur hier steht: die angemeldete
        Oberfläche trägt ihn ebenso. Die Begründung, was er nennt und was
        bewusst nicht, steht dort.
      */}
      <div className="legal-footer__copyright">
        <ProductCopyright />
      </div>
    </footer>
  );
}
