import { describe, expect, it } from 'vitest';
import {
  EMPTY_LEGAL_DOCUMENT,
  TENANT_LEGAL_PAGES,
  TENANT_LEGAL_TEMPLATES,
  type GroupList,
  type MailIdentityConfig,
  type Permissions,
  type TenantLegalPages,
} from '@formsache/shared';

import { tenantOpenItems } from './open-items';

/**
 * **The open items of an organisation** (ADR-0025) — what is measured is the
 * rule, not the wording: *the list reads the state, and on it stands only what
 * something does not work without.*
 *
 * Negative probes, measured while writing:
 *
 * - Turning `smtp === null` into `smtp === undefined` → „sagt während des
 *   Ladens nichts" goes red, and every dashboard would claim for one paint
 *   that this organisation sends nothing.
 * - Taking the appearance or the reply-to address onto the list as well →
 *   „nennt nur, ohne das etwas nicht geht" goes red.
 */

const ALL_PERMISSIONS: Permissions = {
  canBuild: true,
  canViewResponses: true,
  canExport: true,
  canManageSettings: true,
  canManageFormSettings: true,
  canManageUsers: true,
};

const WITHOUT_SMTP: MailIdentityConfig = { smtp: null };

const WITH_SMTP: MailIdentityConfig = {
  smtp: {
    host: 'mail.example.org',
    port: 587,
    secure: false,
    from: 'noreply@example.org',
    auth: null,
  },
};

function groupsWith(permissions: Partial<Permissions>): GroupList {
  return {
    groups: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Bearbeiter',
        color: '#123456',
        rank: 10,
        isSystem: false,
        permissions: { ...ALL_PERMISSIONS, ...permissions },
        memberCount: 1,
      },
    ],
  };
}

/** Legal texts in which every currently applying field is filled. */
const LEGAL_DONE: TenantLegalPages = Object.fromEntries(
  TENANT_LEGAL_PAGES.map((page) => [
    page,
    {
      mode: 'template' as const,
      fills: Object.fromEntries(
        TENANT_LEGAL_TEMPLATES[page].slots.map((slot) => [slot.key, 'x']),
      ),
      conditions: {},
      custom: '',
      link: '',
    },
  ]),
) as TenantLegalPages;

describe('die offenen Punkte einer Organisation', () => {
  it('sagt während des Ladens nichts', () => {
    expect(
      tenantOpenItems({
        smtp: undefined,
        smtpUnreadable: false,
        groups: undefined,
        legal: undefined,
      }),
    ).toEqual([]);
  });

  it('nennt den fehlenden Mailserver — mit der Folge, nicht nur dem Befund', () => {
    const items = tenantOpenItems({
      smtp: WITHOUT_SMTP,
      smtpUnreadable: false,
      groups: undefined,
      legal: LEGAL_DONE,
    });

    expect(items.map((item) => item.key)).toEqual(['smtp']);
    // The sentence is mandatory — an open item without „without this, X does
    // not work" is a line one reads past.
    expect(items[0]?.consequence).toContain('verschickt nichts');
    expect(items[0]?.path).toBe('/admin/mail');
  });

  it('unterscheidet „keiner eingetragen" von „unlesbar gespeichert"', () => {
    const items = tenantOpenItems({
      smtp: undefined,
      smtpUnreadable: true,
      groups: undefined,
      legal: LEGAL_DONE,
    });

    expect(items.map((item) => item.key)).toEqual(['smtp-unreadable']);
    // The organisation believes it has a mail server — and has none.
    expect(items[0]?.consequence).toContain('obwohl ein Mailserver');
  });

  it('nennt eine Organisation, in der keine Gruppe bauen darf', () => {
    const items = tenantOpenItems({
      smtp: WITH_SMTP,
      smtpUnreadable: false,
      groups: groupsWith({ canBuild: false }),
      legal: LEGAL_DONE,
    });

    expect(items.map((item) => item.key)).toEqual(['no-builder-group']);
  });

  it('nennt nur, ohne das etwas nicht geht — eine eingerichtete Organisation ist leer', () => {
    expect(
      tenantOpenItems({
        smtp: WITH_SMTP,
        smtpUnreadable: false,
        groups: groupsWith({}),
        legal: LEGAL_DONE,
      }),
    ).toEqual([]);
  });
});

/**
 * **The legal texts** (ADR-0028) — the item that concerns the organisation,
 * and the case that carries the core of the work item: a placeholder left
 * behind does not count as finished.
 */
describe('die Rechtstexte auf der Liste einer Organisation', () => {
  it('nennt sie, solange nichts hinterlegt ist', () => {
    const items = tenantOpenItems({
      smtp: WITH_SMTP,
      smtpUnreadable: false,
      groups: groupsWith({}),
      legal: {
        imprint: EMPTY_LEGAL_DOCUMENT,
        privacy: EMPTY_LEGAL_DOCUMENT,
      },
    });

    expect(items.map((item) => item.key)).toEqual(['legal']);
    expect(items[0]?.consequence).toContain('Art. 13 DSGVO');
    expect(items[0]?.path).toBe('/admin/legal');
  });

  it('nennt sie auch bei einem eigenen Text mit verbliebenem Platzhalter', () => {
    const items = tenantOpenItems({
      smtp: WITH_SMTP,
      smtpUnreadable: false,
      groups: groupsWith({}),
      legal: {
        ...LEGAL_DONE,
        privacy: {
          mode: 'custom',
          fills: {},
          conditions: {},
          custom: 'Verantwortlich: [[NAME_DER_ORGANISATION]]',
          link: '',
        },
      },
    });

    expect(items.map((item) => item.key)).toEqual(['legal']);
    expect(items[0]?.title).toContain('unvollständig');
  });

  it('sagt nichts, solange das Dokument nicht geladen ist oder diese Rolle es nicht sehen darf', () => {
    expect(
      tenantOpenItems({
        smtp: WITH_SMTP,
        smtpUnreadable: false,
        groups: groupsWith({}),
        legal: undefined,
      }),
    ).toEqual([]);
  });
});
