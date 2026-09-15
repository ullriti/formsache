import { describe, expect, it } from 'vitest';

import {
  builderPath,
  formMembersPath,
  formSettingsPath,
  MAIL_LOG_PATH,
  mailLogPath,
  notificationsPath,
  parseRoute,
  publicFormPath,
  responseDraftPath,
  responseEditPath,
  previewPath,
  responsesPath,
  routeFormId,
  startPath,
  SYSTEM_AI_PATH,
  SYSTEM_MAIL_PATH,
  SYSTEM_MONITORING_PATH,
  SYSTEM_LEGAL_SETTINGS_PATH,
  SYSTEM_PATH,
  SYSTEM_SUPERADMINS_PATH,
  TENANT_APPEARANCE_PATH,
  TENANT_FORM_DEFAULTS_PATH,
  TENANT_MAIL_PATH,
  TENANT_MEMBERS_PATH,
  TENANT_TEMPLATES_PATH,
  TRASH_PATH,
} from './routes';

/**
 * The whole routing table, as a pure function over a string.
 *
 * That is why `parseRoute` is separate from the hook: the addresses of the
 * application are worth pinning down, and pinning them down through a rendered
 * tree would test React instead.
 */

const ID = '019fe400-0000-7000-8000-000000000001';

describe('parseRoute', () => {
  it('reads the dashboard from the root', () => {
    expect(parseRoute('/')).toStrictEqual({ kind: 'dashboard' });
    expect(parseRoute('')).toStrictEqual({ kind: 'dashboard' });
  });

  it('reads the builder and its form id', () => {
    expect(parseRoute(`/forms/${ID}`)).toStrictEqual({
      kind: 'builder',
      formId: ID,
    });
  });

  it('reads the responses table of one form', () => {
    expect(parseRoute(`/forms/${ID}/responses`)).toStrictEqual({
      kind: 'responses',
      formId: ID,
    });
  });

  it('reads the Testmodus of one form', () => {
    // Under the form, behind the login — **never** under `/f/<Adresse>`
    // (first boundary).
    expect(parseRoute(previewPath(ID))).toStrictEqual({
      kind: 'preview',
      formId: ID,
    });
  });

  it('reads the settings of one form', () => {
    expect(parseRoute(`/forms/${ID}/settings`)).toStrictEqual({
      kind: 'form-settings',
      formId: ID,
    });
  });

  /**
   * The organisation's form standards — an address of its own rather
   * than a tab parameter, which is the shape all three tabs now take.
   *
   * **This case is a regression guard.** The address has been in
   * use and E2E cases point at it; the two siblings arriving next to it
   * must not move it.
   */
  it('reads the tenant form standards, unchanged', () => {
    expect(TENANT_FORM_DEFAULTS_PATH).toBe('/admin/form-defaults');
    expect(parseRoute(TENANT_FORM_DEFAULTS_PATH)).toStrictEqual({
      kind: 'tenant-form-defaults',
    });
  });

  /**
   * The other two tabs of the tenant administration. Three sibling addresses, so a tab is a place one can link to
   * and return to with the back button.
   */
  it('reads the three tabs of the Organisations-Verwaltung as three addresses', () => {
    expect(parseRoute(TENANT_APPEARANCE_PATH)).toStrictEqual({
      kind: 'tenant-appearance',
    });
    expect(parseRoute(TENANT_MEMBERS_PATH)).toStrictEqual({
      kind: 'tenant-members',
    });
    const paths = new Set([
      TENANT_APPEARANCE_PATH,
      TENANT_FORM_DEFAULTS_PATH,
      TENANT_MEMBERS_PATH,
      SYSTEM_PATH,
      SYSTEM_MAIL_PATH,
    ]);
    expect(paths.size).toBe(5);
  });

  /**
   * The fourth sibling, added after the handoff's own three (ADR-0013) — the organisation's own sending identity.
   */
  it('reads the fourth Organisations-Verwaltung sibling, Mailversand', () => {
    expect(parseRoute(TENANT_MAIL_PATH)).toStrictEqual({
      kind: 'tenant-mail',
    });
    const paths = new Set([
      TENANT_APPEARANCE_PATH,
      TENANT_FORM_DEFAULTS_PATH,
      TENANT_MEMBERS_PATH,
      TENANT_MAIL_PATH,
      SYSTEM_PATH,
      SYSTEM_MAIL_PATH,
    ]);
    expect(paths.size).toBe(6);
  });

  /**
   * The seventh sibling (ADR-0032) — this organisation's own notification
   * templates, moved here in full from the system administration. There is
   * no installation-wide route left for them at all any more.
   */
  it('reads the seventh Organisations-Verwaltung sibling, Vorlagen', () => {
    expect(parseRoute(TENANT_TEMPLATES_PATH)).toStrictEqual({
      kind: 'tenant-templates',
    });
    const paths = new Set([
      TENANT_APPEARANCE_PATH,
      TENANT_FORM_DEFAULTS_PATH,
      TENANT_MEMBERS_PATH,
      TENANT_MAIL_PATH,
      TENANT_TEMPLATES_PATH,
      SYSTEM_PATH,
      SYSTEM_MAIL_PATH,
    ]);
    expect(paths.size).toBe(7);
  });

  /**
   * **The six tabs of the system administration** (finding 16; *Rechtstexte*
   * since ADR-0028, *Superadmins* since ADR-0029) — six addresses like any
   * other, and what keeps everybody else out is a guard and not a URL.
   *
   * ⚠️ Until 2026-08-19 the case was called „die vier Reiter" and counted a set
   * of four paths, while the bar had long been carrying six: three tabs had
   * been added without the count growing along with them. The count is the
   * reason for the case — two tabs sharing one address are otherwise not to be
   * told apart from „einer fehlt" —, so it now counts **all** of them.
   *
   * A seventh tab, *Vorlagen* (ADR-0022), stood here until ADR-0032 moved
   * notification templates from the installation to every organisation — its
   * case moved with it, to `TENANT_TEMPLATES_PATH` below.
   */
  it('reads the six tabs of the Systemverwaltung', () => {
    expect(parseRoute(SYSTEM_PATH)).toStrictEqual({ kind: 'system-tenants' });
    expect(parseRoute(SYSTEM_MONITORING_PATH)).toStrictEqual({
      kind: 'system-monitoring',
    });
    expect(parseRoute(SYSTEM_MAIL_PATH)).toStrictEqual({ kind: 'system-mail' });
    expect(parseRoute(SYSTEM_AI_PATH)).toStrictEqual({ kind: 'system-ai' });
    expect(parseRoute(SYSTEM_LEGAL_SETTINGS_PATH)).toStrictEqual({
      kind: 'system-legal-settings',
    });
    // The sixth tab (ADR-0029) — who carries the system administration.
    expect(parseRoute(SYSTEM_SUPERADMINS_PATH)).toStrictEqual({
      kind: 'system-superadmins',
    });
    // Six tabs, six addresses — no two share one.
    expect(
      new Set([
        SYSTEM_PATH,
        SYSTEM_MONITORING_PATH,
        SYSTEM_MAIL_PATH,
        SYSTEM_AI_PATH,
        SYSTEM_LEGAL_SETTINGS_PATH,
        SYSTEM_SUPERADMINS_PATH,
      ]).size,
    ).toBe(6);
  });

  it('does not invent an eighth tab', () => {
    expect(parseRoute('/admin/system/organisationen')).toStrictEqual({
      kind: 'not-found',
      path: '/admin/system/organisationen',
    });
  });

  /**
   * The trash (handoff §Screens/Views 10) — a sibling
   * address of the other `/admin/…` pages, kept apart by the guard behind
   * it rather than by the URL.
   */
  it('reads the Papierkorb', () => {
    expect(parseRoute(TRASH_PATH)).toStrictEqual({ kind: 'trash' });
    const paths = new Set([
      TENANT_APPEARANCE_PATH,
      TENANT_FORM_DEFAULTS_PATH,
      TENANT_MEMBERS_PATH,
      TENANT_MAIL_PATH,
      SYSTEM_PATH,
      SYSTEM_MAIL_PATH,
      TRASH_PATH,
    ]);
    expect(paths.size).toBe(7);
  });

  /**
   * Nutzerrechte **per form** — under the form,
   * and one segment away from the organisation-wide list it links to.
   */
  it('reads the per-form user rights, and keeps them apart from the organisation’s', () => {
    expect(parseRoute(`/forms/${ID}/members`)).toStrictEqual({
      kind: 'form-members',
      formId: ID,
    });
    expect(parseRoute(TENANT_MEMBERS_PATH).kind).toBe('tenant-members');
  });

  /**
   * The system layer below them — a sibling address, not a segment under the
   * organisation's standards: neither of the two pages is part of the other.
   */
  it('keeps the Systemverwaltung apart from the organisation’s pages', () => {
    expect(SYSTEM_PATH).not.toBe(TENANT_FORM_DEFAULTS_PATH);
    expect(parseRoute('/admin')).toStrictEqual({
      kind: 'not-found',
      path: '/admin',
    });
  });

  /** The requirement — the notifications of one form, under that form. */
  it('reads the notifications of one form', () => {
    expect(parseRoute(`/forms/${ID}/notifications`)).toStrictEqual({
      kind: 'notifications',
      formId: ID,
    });
  });

  /**
   * The requirement, Konzept no. 32: the log is **tenant-wide**, and
   * the form is a prefilter one arrives with rather than part of its identity.
   * `formId: null` is therefore a state the route can express — a per-form
   * address could not show the rows whose form has since been deleted.
   */
  it('reads the mail log with and without the form prefilter', () => {
    expect(parseRoute(MAIL_LOG_PATH)).toStrictEqual({
      kind: 'mail-log',
      formId: null,
    });
    expect(parseRoute(`${MAIL_LOG_PATH}/${ID}`)).toStrictEqual({
      kind: 'mail-log',
      formId: ID,
    });
  });

  it('reads the public form address', () => {
    expect(parseRoute('/f/abc123')).toStrictEqual({
      kind: 'public-form',
      slug: 'abc123',
    });
  });

  /**
   * The requirement — the address of one submitted answer. The token is the
   * whole capability, so the route carries nothing else.
   */
  it('reads the edit address of one answer', () => {
    expect(parseRoute('/a/AbCd_1234-xyz')).toStrictEqual({
      kind: 'response-edit',
      token: 'AbCd_1234-xyz',
    });
  });

  /**
   * The requirement — the resume address of one draft. Same shape as the edit
   * address, and for the same reason: the token is the whole capability.
   */
  it('reads the resume address of one draft', () => {
    expect(parseRoute('/e/AbCd_1234-xyz')).toStrictEqual({
      kind: 'response-draft',
      token: 'AbCd_1234-xyz',
    });
  });

  /**
   * **The two account addresses** (ADR-0020, ADR-0024) — the same capability,
   * two wordings.
   *
   * The server does not tell them apart when they are redeemed; what the
   * address carries is the sentence the page says. They must therefore be
   * readable apart from one another — and one segment deeper neither of the two
   * may take hold any more, or else a half-copied link would lead to a page
   * that accepts a token.
   */
  it('liest den Rücksetz- und den Einladungslink auseinander', () => {
    expect(parseRoute('/password/AbCd_1234-xyz')).toStrictEqual({
      kind: 'password-reset',
      token: 'AbCd_1234-xyz',
    });
    expect(parseRoute('/invitation/AbCd_1234-xyz')).toStrictEqual({
      kind: 'account-invitation',
      token: 'AbCd_1234-xyz',
    });
    expect(parseRoute('/invitation/abc/extra').kind).toBe('not-found');
    expect(parseRoute('/invitation').kind).toBe('not-found');
  });

  /** The three public segments must not shadow each other. */
  it('keeps the fill-in, the edit and the draft address apart', () => {
    expect(parseRoute('/f/abc123').kind).toBe('public-form');
    expect(parseRoute('/a/abc123').kind).toBe('response-edit');
    expect(parseRoute('/e/abc123').kind).toBe('response-draft');
    // One segment deeper is not an edit or draft address either — a near miss
    // must not resolve to somebody's answer.
    expect(parseRoute('/a/abc123/extra').kind).toBe('not-found');
    expect(parseRoute('/a').kind).toBe('not-found');
    expect(parseRoute('/e/abc123/extra').kind).toBe('not-found');
    expect(parseRoute('/e').kind).toBe('not-found');
  });

  it('tolerates a trailing slash', () => {
    expect(parseRoute(`/forms/${ID}/`)).toStrictEqual({
      kind: 'builder',
      formId: ID,
    });
  });

  /**
   * A slug is base64url and needs no escaping, but a *form id* out of a
   * hand-edited URL can carry anything. Round-tripping through the path
   * builders is what keeps a value with a slash in it from silently becoming
   * two segments and a different route.
   */
  it('round-trips through the path builders', () => {
    expect(parseRoute(builderPath('a/b'))).toStrictEqual({
      kind: 'builder',
      formId: 'a/b',
    });
    expect(parseRoute(responsesPath('a/b'))).toStrictEqual({
      kind: 'responses',
      formId: 'a/b',
    });
    expect(parseRoute(formSettingsPath('a/b'))).toStrictEqual({
      kind: 'form-settings',
      formId: 'a/b',
    });
    expect(parseRoute(publicFormPath('x y'))).toStrictEqual({
      kind: 'public-form',
      slug: 'x y',
    });
    expect(parseRoute(responseEditPath('x/y'))).toStrictEqual({
      kind: 'response-edit',
      token: 'x/y',
    });
    expect(parseRoute(responseDraftPath('x/y'))).toStrictEqual({
      kind: 'response-draft',
      token: 'x/y',
    });
    expect(parseRoute(notificationsPath('a/b'))).toStrictEqual({
      kind: 'notifications',
      formId: 'a/b',
    });
    expect(parseRoute(mailLogPath('a/b'))).toStrictEqual({
      kind: 'mail-log',
      formId: 'a/b',
    });
    expect(parseRoute(mailLogPath())).toStrictEqual({
      kind: 'mail-log',
      formId: null,
    });
    expect(parseRoute(formMembersPath('a/b'))).toStrictEqual({
      kind: 'form-members',
      formId: 'a/b',
    });
  });

  it('answers not-found for anything else, rather than guessing', () => {
    expect(parseRoute('/forms')).toStrictEqual({
      kind: 'not-found',
      path: '/forms',
    });
    // One segment deeper than the responses table, so the near-miss is
    // covered rather than only the obviously wrong path.
    expect(parseRoute(`/forms/${ID}/responses/1`)).toStrictEqual({
      kind: 'not-found',
      path: `/forms/${ID}/responses/1`,
    });
    expect(parseRoute('/admin')).toStrictEqual({
      kind: 'not-found',
      path: '/admin',
    });
    // A sibling under the Verwaltung that sounds plausible must not resolve to
    // one of the five that exist.
    expect(parseRoute('/admin/branding')).toStrictEqual({
      kind: 'not-found',
      path: '/admin/branding',
    });
    // …and none of the five takes a further segment, so an organisation cannot be named
    // in a tenant administration address by tacking one on.
    expect(parseRoute(`${TENANT_MEMBERS_PATH}/${ID}`)).toStrictEqual({
      kind: 'not-found',
      path: `${TENANT_MEMBERS_PATH}/${ID}`,
    });
    expect(parseRoute(`${SYSTEM_PATH}/${ID}`)).toStrictEqual({
      kind: 'not-found',
      path: `${SYSTEM_PATH}/${ID}`,
    });
    expect(parseRoute(`${TRASH_PATH}/${ID}`)).toStrictEqual({
      kind: 'not-found',
      path: `${TRASH_PATH}/${ID}`,
    });
    // A near miss under the mail log must not resolve to it either — the
    // prefilter is exactly one segment deep.
    expect(parseRoute(`${MAIL_LOG_PATH}/${ID}/extra`)).toStrictEqual({
      kind: 'not-found',
      path: `${MAIL_LOG_PATH}/${ID}/extra`,
    });
  });
});

/**
 * „Aktuelles Formular" of the handoff's navigation, as one answer. Both navigations — the desktop subheader and the mobile sheet — ask
 * this function, so the two cannot disagree about whether there is a current
 * form.
 */
describe('routeFormId', () => {
  it('names the form of every form-scoped address', () => {
    expect(routeFormId({ kind: 'builder', formId: ID })).toBe(ID);
    expect(routeFormId({ kind: 'preview', formId: ID })).toBe(ID);
    expect(routeFormId({ kind: 'responses', formId: ID })).toBe(ID);
    expect(routeFormId({ kind: 'form-settings', formId: ID })).toBe(ID);
    expect(routeFormId({ kind: 'notifications', formId: ID })).toBe(ID);
    // „☷ Nutzerrechte" of the handoff's subheader belongs to the current form
    //  — the organisation-wide list below does not.
    expect(routeFormId({ kind: 'form-members', formId: ID })).toBe(ID);
  });

  /**
   * The mail log counts **only with its prefilter**. Without one it is the
   * whole organisation's log and belongs to no form — a „Bearbeiten" entry
   * next to it would have to guess which one.
   */
  it('treats the mail log as form-scoped only while it is prefiltered', () => {
    expect(routeFormId({ kind: 'mail-log', formId: ID })).toBe(ID);
    expect(routeFormId({ kind: 'mail-log', formId: null })).toBeNull();
  });

  it('names no form for the addresses that are about none', () => {
    expect(routeFormId({ kind: 'dashboard' })).toBeNull();
    expect(routeFormId({ kind: 'tenant-form-defaults' })).toBeNull();
    expect(routeFormId({ kind: 'tenant-appearance' })).toBeNull();
    expect(routeFormId({ kind: 'tenant-members' })).toBeNull();
    expect(routeFormId({ kind: 'tenant-mail' })).toBeNull();
    expect(routeFormId({ kind: 'tenant-templates' })).toBeNull();
    expect(routeFormId({ kind: 'system-tenants' })).toBeNull();
    expect(routeFormId({ kind: 'trash' })).toBeNull();
    expect(routeFormId({ kind: 'system-monitoring' })).toBeNull();
    expect(routeFormId({ kind: 'public-form', slug: 'abc' })).toBeNull();
    expect(routeFormId({ kind: 'not-found', path: '/x' })).toBeNull();
  });
});

/**
 * **The former addresses of the system administration** (finding 16).
 *
 * They were reachable for months and stand in bookmarks. What they must not do
 * is land on the 404 page — a rename that ships as a defect is no rename.
 */

/**
 * **Where a freshly signed-in person lands** (findings 15 and 26).
 */
describe('startPath', () => {
  it('sends a superadmin without any membership to the Systemverwaltung', () => {
    expect(startPath({ isSuperadmin: true, membershipCount: 0 })).toBe(
      SYSTEM_PATH,
    );
  });

  /**
   * A superadmin who **also** works in an organisation has something to do on
   * the dashboard — it shows that organisation's forms. Sending them past the
   * start page would mean taking their own work away from them because they
   * administer the installation on the side.
   */
  it('leaves everybody else on the dashboard', () => {
    expect(startPath({ isSuperadmin: true, membershipCount: 1 })).toBe('/');
    expect(startPath({ isSuperadmin: false, membershipCount: 0 })).toBe('/');
    expect(startPath({ isSuperadmin: false, membershipCount: 3 })).toBe('/');
  });
});

/**
 * **The legal-text pages** (ADR-0028) — they are the only ones that lie at the
 * root *without* a prefix, and that is why the demarcation downwards is what
 * has to be measured: an unknown single-segment address stays the
 * 404 page.
 */
describe('die Adressen der Rechtstexte', () => {
  it('liest die beiden Seiten der Installation und die Lizenzseite', () => {
    expect(parseRoute('/imprint')).toStrictEqual({
      kind: 'system-legal',
      page: 'imprint',
    });
    expect(parseRoute('/privacy')).toStrictEqual({
      kind: 'system-legal',
      page: 'privacy',
    });
    expect(parseRoute('/licences')).toStrictEqual({ kind: 'licences' });
  });

  it('liest die beiden Seiten einer Organisation über ihren Kurznamen', () => {
    expect(parseRoute('/o/MUST/imprint')).toStrictEqual({
      kind: 'tenant-legal',
      shortName: 'MUST',
      page: 'imprint',
    });
    expect(parseRoute('/o/MUST/privacy')).toStrictEqual({
      kind: 'tenant-legal',
      shortName: 'MUST',
      page: 'privacy',
    });
  });

  it('lässt alles andere die 404-Seite bleiben', () => {
    // The counter-check to the root address: „every single segment is a legal
    // text" would be the convenient and wrong reading.
    expect(parseRoute('/irgendwas')).toStrictEqual({
      kind: 'not-found',
      path: '/irgendwas',
    });
    expect(parseRoute('/o/MUST/geheim')).toStrictEqual({
      kind: 'not-found',
      path: '/o/MUST/geheim',
    });
  });

  it('gibt den Reitern der Verwaltung ihre eigenen Adressen', () => {
    expect(parseRoute('/admin/legal')).toStrictEqual({
      kind: 'tenant-legal-settings',
    });
    expect(parseRoute('/admin/system/legal')).toStrictEqual({
      kind: 'system-legal-settings',
    });
  });
});
