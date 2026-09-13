import {
  SYSTEM_LEGAL_PAGES,
  SYSTEM_LEGAL_TEMPLATES,
  legalPageStatus,
  type SystemLegalPages,
  type SystemMailSettings,
} from '@formsache/shared';

import {
  SYSTEM_LEGAL_SETTINGS_PATH,
  SYSTEM_MAIL_PATH,
  SYSTEM_PATH,
  SYSTEM_SUPERADMINS_PATH,
} from '../../router/routes';
import type { OpenItem } from '../open-items/OpenItemsList';

/**
 * **The open items of an installation** (ADR-0022, continued
 * 2026-08-18) — what the setup assistant left open, and derived
 * from the **actual state**.
 *
 * ## Why no „step skipped" marker
 *
 * Because it would drift apart, and in both directions. Whoever skips the mail
 * server in the assistant and enters it two minutes later in the tab
 * would have an open item that does not exist; whoever sets it in the assistant
 * and later removes it again would have none, although the alarm no longer
 * reaches anyone. A marker describes a **past**, and what
 * matters here is the present: *is a base address on file?*
 * — that is a question to the same documents the tabs
 * live off anyway.
 *
 * The price is spelled out: this list can only name what can be read off the
 * state. An „I deliberately left the templates the way they
 * are" is therefore **not** in it — and rightly so, because it is
 * no open item.
 *
 * ## What belongs in here, and what does not
 *
 * The yardstick is one and the same for every item: **a state that is no valid
 * end state**, and each with the one sentence that says why. A list that also
 * carries states somebody may legitimately want to stay in is a list that gets
 * clicked away — and then the mail server is on it as well. **Two** questions
 * decide it, and an item needs a *yes* to one of them:
 *
 * 1. **Does something not work without it?** The ordinary case, and the one
 *    most items answer: without a base address the links in the mail lead
 *    nowhere.
 * 2. **Would a failure no longer be repairable without it?** Everything works
 *    — right up to the one moment this state was the way back from, and from
 *    then on nothing does, and no page of this application can still be reached
 *    to put it right.
 *
 * The second question is the younger one (ADR-0029) and is **deliberately kept
 * narrow**, otherwise it is no rule any more: it asks for the **last way back
 * into the application**, not for „risky", not for „unpleasant", not for
 * „a second one would be nicer". Exactly one item answers it today
 * (`single-superadmin`); whoever adds a second one names the failure it is the
 * way back from, and why that way leads past every surface.
 *
 * The reply address, the AI and the templates are therefore *not* on the list,
 * although the assistant offers them: without them everything works, only
 * differently (no reply address in the mail, no AI feature, the shipped
 * templates) — and it stays that way when something goes wrong.
 */

/**
 * The item itself lives in `views/open-items/` — it is the shape this list
 * shares with that of an Organisation (ADR-0025). What stands here are
 * the **questions about the state of this installation**, and those it shares
 * with nobody.
 */
export type { OpenItem };

export interface OpenItemsInput {
  /**
   * The mail document of the installation, or `undefined` as long as it is not
   * loaded.
   *
   * `undefined` does **not** mean „nothing set up": a list that claims four
   * open items while loading and then takes them away again is a
   * fright without cause. If the document is missing, so is the information.
   */
  readonly mail: SystemMailSettings | undefined;
  /** How many Organisationen there are, or `undefined` while loading. */
  readonly tenantCount: number | undefined;
  /**
   * The legal texts of the installation, or `undefined` while loading (ADR-0028).
   *
   * The same rule as with the mail document: `undefined` does **not** mean
   * „nothing on file".
   *
   * **Die Seiten *und* der KI-Zustand, in einem Wert** (Review-Runde 5 Nr. 2):
   * ob die KI-Funktion eingerichtet ist, entscheidet mit darüber, ob die
   * Datenschutzerklärung fertig ist — sie hat dann sieben Felder mehr. Beide
   * kommen aus derselben Antwort, und ein zweites Feld daneben wäre die
   * Gelegenheit, das eine ohne das andere zu setzen: die Ampel hier sagte dann
   * „fertig" über eine Seite, deren Formular sieben leere Felder zeigt.
   */
  readonly legal:
    | { readonly pages: SystemLegalPages; readonly aiActive: boolean }
    | undefined;
  /**
   * How many people carry the system administration (ADR-0029), or `undefined`
   * while loading.
   *
   * Same rule again: `undefined` claims nothing. A list that says „only one
   * person administers the system" for a tenth of a second and then takes it
   * back has said the most alarming sentence it knows without having read
   * anything.
   */
  readonly superadminCount: number | undefined;
}

export function openItems({
  mail,
  tenantCount,
  legal,
  superadminCount,
}: OpenItemsInput): OpenItem[] {
  const items: OpenItem[] = [];

  /**
   * **Only one person administers the system** (ADR-0029) — the item the second
   * question of the head comment exists for.
   *
   * With one superadministrator everything works. It stops working the moment
   * this one account is gone — password lost, account locked, the person left
   * — and then no page leads back: the setup assistant does not show itself
   * once accounts exist, `scripts/create-superadmin.sh` refuses for the same
   * reason (ADR-0022 §3), and „Passwort vergessen" only helps while the mailbox
   * is still reachable. What is left is a hand-written `UPDATE` on the
   * production database — the very state the Superadmins tab was built against.
   *
   * **It stands first**, and that is the order this list already follows: the
   * steps of the setup assistant (`views/setup/steps.ts` — access, base-url,
   * mail, addresses, templates, ai, legal, tenant). This item hangs off its
   * *first* step, and off the only one that cannot be skipped. Reading it
   * top-down that is also the honest order: every other item can still be done
   * tomorrow, this one is the only one that can stop being doable at all.
   *
   * `0` does not occur — whoever sees this view has passed `SuperadminGuard`
   * — and is therefore no case of its own; `undefined` is the loading case, and
   * both fall out of the comparison against `1` on their own.
   */
  if (superadminCount === 1) {
    items.push({
      key: 'single-superadmin',
      title: 'Nur eine Person verwaltet das System',
      consequence:
        'Verliert dieses eine Konto seinen Zugang, kommt an die Systemverwaltung niemand mehr heran: Einrichtungsseite und Befehl legen nichts mehr an, sobald es Konten gibt, und zurück führt dann nur noch ein Eingriff in der Datenbank.',
      path: SYSTEM_SUPERADMINS_PATH,
      action: 'Zu den Superadmins',
    });
  }

  if (mail?.publicBaseUrl === null) {
    items.push({
      key: 'base-url',
      title: 'Keine Basis-Adresse hinterlegt',
      consequence:
        'Links in Mails bleiben unaufgelöst: der Bearbeiten-Link einer Bestätigung und der Rücksetz-Link für ein vergessenes Passwort zeigen nirgendwohin.',
      path: SYSTEM_MAIL_PATH,
      action: 'Zu Mailserver & Adressen',
    });
  }

  if (mail?.smtp === null) {
    items.push({
      key: 'smtp',
      title: 'Kein Mailserver der Instanz eingerichtet',
      consequence:
        'Die Installation selbst verschickt nichts — keine Betriebsmeldung, keine Testmail. Die Organisationen sind davon nicht betroffen; jede sendet über ihren eigenen Mailserver.',
      path: SYSTEM_MAIL_PATH,
      action: 'Zu Mailserver & Adressen',
    });
  }

  if (mail?.opsAlertEmail === null) {
    items.push({
      key: 'ops-alert',
      title: 'Keine Betreiberadresse für Betriebsalarme',
      consequence:
        'Ein Alarm erreicht niemanden: gestaute Post, ein ausbleibender Aufräumlauf oder eine volle Ablage stehen dann nur in der Überwachung und melden sich nicht von selbst.',
      path: SYSTEM_MAIL_PATH,
      action: 'Zu Mailserver & Adressen',
    });
  }

  /**
   * **The legal texts** (ADR-0028) — and they stand here, although the first
   * of the two questions above seems to answer „no": the application runs
   * without an Impressum.
   *
   * The apparent contradiction resolves at the yardstick behind both
   * questions: it then runs **unlawfully**, and visibly so for
   * every participant — the footer of every form links to a page
   * that says nothing is on file. That is no valid end state,
   * and that was exactly the criterion.
   *
   * **Two states, one item.** „Nothing on file" and „on file, but
   * with open placeholders" are different sentences and the same defect:
   * both times the page is not ready for publication. A text with a
   * remaining placeholder must therefore count as finished nowhere — here as
   * little as on the public page.
   */
  if (legal !== undefined) {
    const open = SYSTEM_LEGAL_PAGES.filter((page) => {
      const status = legalPageStatus(
        SYSTEM_LEGAL_TEMPLATES[page],
        legal.pages[page],
        {
          organisationName: null,
          organisationShortName: null,
          operatorName: null,
          // **Der wahre Zustand** (Review-Runde 5 Nr. 2). Mit `false` zählte
          // diese Liste die sieben Felder des KI-Abschnitts nicht mit und
          // meldete eine Datenschutzerklärung als fertig, die es nicht war.
          aiActive: legal.aiActive,
          redirectTarget: null,
        },
      );
      /*
        **Beide verbliebenen Seiten sind Pflicht für jeden Betreiber**, also
        zählt jede, die nicht fertig ist. Die Unterscheidung, die hier einmal
        stand, hing an der freiwilligen Erklärung zur Barrierefreiheit; die
        ist seit Review-Runde 4 Nr. 4 ersatzlos gestrichen, und mit ihr die
        einzige Seite, die man legitim leer lassen konnte.
      */
      return status !== 'ready';
    });
    if (open.length > 0) {
      const titles = open
        .map((page) => SYSTEM_LEGAL_TEMPLATES[page].title)
        .join(', ');
      items.push({
        key: 'legal',
        title:
          open.length === SYSTEM_LEGAL_PAGES.length
            ? 'Keine Rechtstexte der Installation hinterlegt'
            : `Rechtstexte unvollständig: ${titles}`,
        consequence:
          'Diese Seiten sind aus der Fußzeile jedes öffentlichen Formulars verlinkt und sagen Teilnehmenden, dass die Angaben fehlen. Ohne Anbieterkennzeichnung (§ 5 DDG, § 18 Abs. 1 MStV) und ohne Datenschutzerklärung (Art. 13 DSGVO) darf die Installation nicht öffentlich erreichbar sein.',
        path: SYSTEM_LEGAL_SETTINGS_PATH,
        action: 'Zu den Rechtstexten',
      });
    }
  }

  if (tenantCount === 0) {
    items.push({
      key: 'tenant',
      title: 'Keine Organisation angelegt',
      consequence:
        'Niemand kann ein Formular anlegen: Formulare, Antworten und Rechte gehören immer einer Organisation.',
      path: SYSTEM_PATH,
      action: 'Zu den Organisationen',
    });
  }

  return items;
}
