import {
  TENANT_LEGAL_PAGES,
  TENANT_LEGAL_TEMPLATES,
  openTenantLegalPages,
  type GroupList,
  type MailIdentityConfig,
  type TenantLegalPages,
} from '@formsache/shared';

import {
  TENANT_LEGAL_SETTINGS_PATH,
  TENANT_MAIL_PATH,
  TENANT_MEMBERS_PATH,
} from '../../router/routes';
import type { OpenItem } from '../open-items/OpenItemsList';

/**
 * **The open items of an organization** (ADR-0025) — what the initial setup has
 * left open, derived from the **actual state**.
 *
 * The same construction and the same rule as the installation's list
 * (`views/system-settings/open-items.ts`), and the rule is the more important
 * half:
 *
 * ## No “step skipped” marker
 *
 * It would diverge in both directions. Whoever skips the mail server in the
 * wizard and enters it two minutes later in the tab would have an open item
 * that does not exist; whoever sets it in the wizard and removes it again later
 * would have none, although this organization's mail has been piling up ever
 * since. A marker describes a **past**; what is asked for is the present — and
 * that stands in the same documents the tabs live off anyway.
 *
 * ## What belongs in here, and what does not
 *
 * Only states without which **something does not work**. The branding, the
 * reply address, SSO, the AI and the form defaults are therefore *not* on it,
 * although the wizard offers them: without them everything works, just
 * differently. A list carrying items that are a valid end state is a list one
 * looks past — and then the mail server is on it too.
 *
 * ⚠️ **The organization's own base address is deliberately not on it**, even
 * though the wizard carries it: if it is missing, the installation's applies,
 * and *whether that one is set* this organization cannot see — the system row
 * belongs to the superadmin. “No base address of its own” would therefore be an
 * item that means nothing in the overwhelming majority of installations.
 * Whoever does want to carry it needs, first of all, an answer from the server
 * about which address actually applies.
 */

export interface TenantOpenItemsInput {
  /**
   * This organization's mail block, or `undefined` for as long as it is not
   * loaded (or this role may not see it).
   *
   * `undefined` does **not** mean “nothing set up”: a list that asserts an open
   * item while loading and then takes it away again is a fright without cause.
   * If the document is missing, so is the information — and whoever may not see
   * it at all gets no items that they could not settle.
   */
  readonly smtp: MailIdentityConfig | undefined;
  /**
   * Whether the stored mail configuration is **unreadable** (the 500 from
   * `smtp-config.service.ts`). An item of its own and not the same one as “no
   * mail server”: the organization believes it has one, and has none.
   */
  readonly smtpUnreadable: boolean;
  /** This organization's groups, or `undefined` while loading. */
  readonly groups: GroupList | undefined;
  /**
   * This organization's legal texts, or `undefined` while loading or when this
   * role may not see them (ADR-0028).
   */
  readonly legal: TenantLegalPages | undefined;
}

export function tenantOpenItems({
  smtp,
  smtpUnreadable,
  groups,
  legal,
}: TenantOpenItemsInput): OpenItem[] {
  const items: OpenItem[] = [];

  if (smtpUnreadable) {
    items.push({
      key: 'smtp-unreadable',
      title: 'Der Mailversand ist unlesbar gespeichert',
      consequence:
        'Diese Organisation verschickt nichts, obwohl ein Mailserver eingetragen scheint: Bestätigungen und Benachrichtigungen bleiben in der Warteschlange, bis der Block neu gespeichert wird.',
      path: TENANT_MAIL_PATH,
      action: 'Zum Mailversand',
    });
  } else if (smtp?.smtp === null) {
    items.push({
      key: 'smtp',
      title: 'Kein Mailserver dieser Organisation eingerichtet',
      consequence:
        'Diese Organisation verschickt nichts: keine Bestätigung an Teilnehmer, keine Benachrichtigung an Bearbeiter. Die Mails bleiben in der Warteschlange — der Mailserver der Installation springt nicht ein, er gehört dem Betrieb.',
      path: TENANT_MAIL_PATH,
      action: 'Zum Mailversand',
    });
  }

  /**
   * **No group may build** — the state in which an organization looks fully set
   * up and yet nobody can create a form.
   *
   * It does not arise on its own (the default groups bring the permission with
   * them), but by taking away — and then nobody notices it, because the
   * „+ Neues Formular" button is simply no longer there.
   */
  if (
    groups !== undefined &&
    groups.groups.length > 0 &&
    !groups.groups.some((group) => group.permissions.canBuild)
  ) {
    items.push({
      key: 'no-builder-group',
      title: 'Keine Gruppe darf Formulare bearbeiten',
      consequence:
        'Niemand in dieser Organisation kann ein Formular anlegen oder ändern — das Recht „Bearbeiten" hat keine der Gruppen.',
      path: TENANT_MEMBERS_PATH,
      action: 'Zu Gruppen und Rechten',
    });
  }

  /**
   * **The legal texts** (ADR-0028) — the only item on this list whose
   * consequence is not “something does not work” but “something is unlawful”.
   *
   * It stands here nonetheless, and by the very yardstick the paragraph above
   * sets up: a published form without privacy notices does not fulfil the duty
   * to inform under Art. 13 GDPR, and that is not a valid end state — unlike
   * “no branding of its own”.
   *
   * ⚠️ **Unlike with the branding, this organization can also close the item
   * itself**, and that is the difference from the base address, which is
   * deliberately *not* on this list: there the answer hangs on the system row,
   * which an organization may not see. Its own legal texts it does see.
   *
   * “Incomplete” counts the same as “nothing at all”: a text with a remaining
   * placeholder is not ready for publication, and carrying it here as settled
   * would be the quiet variant of the very error this whole function is built
   * against.
   */
  if (legal !== undefined) {
    // Which pages, not merely how many: this list stands behind
    // `can_manage_settings` and is read by the very people who can remedy it,
    // so naming them is the whole use of it. The judgement itself is the
    // shared one (`openTenantLegalPages`), so that this list and the notice
    // before publishing cannot fall out over what „fertig" means.
    const open = openTenantLegalPages(legal);
    if (open.length > 0) {
      items.push({
        key: 'legal',
        title:
          open.length === TENANT_LEGAL_PAGES.length
            ? 'Keine Rechtstexte dieser Organisation hinterlegt'
            : `Rechtstexte unvollständig: ${open
                .map((page) => TENANT_LEGAL_TEMPLATES[page].title)
                .join(', ')}`,
        consequence:
          'Kein Formular dieser Organisation erfüllt die Informationspflicht nach Art. 13 DSGVO: Teilnehmende erfahren nicht, wofür ihre Angaben verwendet werden und wie lange sie bleiben. Die Seiten sind aus der Fußzeile jedes Formulars verlinkt und sagen dort, dass die Auskunft fehlt.',
        path: TENANT_LEGAL_SETTINGS_PATH,
        action: 'Zu den Rechtstexten',
      });
    }
  }

  return items;
}
