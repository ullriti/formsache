/**
 * Routing — hand-written, on the History API. The public fill-in URL is the
 * reason it exists at all.
 *
 * **Why not a router library.** The application has four addresses and
 * needs none of what a router brings beyond them: no nested layouts, no data
 * loaders, no route-level code splitting. The project already writes its own
 * component library, its own drag-and-drop and its own cookie parser
 * (ADR-0002, `CONTRIBUTING.md` "prefer the standard library"), and a dependency
 * whose concepts outnumber its uses would be the odd one out. Roughly sixty
 * lines here replace it; if nested routes or loaders ever become the shape of
 * the problem, this module is small enough to throw away.
 *
 * **Why real URLs at all**, rather than the prototype's `view` state: a
 * published form is addressed by a link in an e-mail, the builder is
 * bookmarked and shared between editors, and the back button has to work in
 * both. A single `view` variable cannot express any of that.
 */

import {
  ACCOUNT_INVITATION_SEGMENT,
  LEGAL_ORG_SEGMENT,
  LICENCES_PATH,
  PASSWORD_RESET_SEGMENT,
  PUBLIC_FORM_SEGMENT,
  RESPONSE_DRAFT_SEGMENT,
  RESPONSE_EDIT_SEGMENT,
  systemLegalPageOf,
  tenantLegalPageOf,
  type SystemLegalPage,
  type TenantLegalPage,
} from '@formsache/shared';

/** The addresses this application recognizes. */
export type Route =
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'builder'; readonly formId: string }
  | { readonly kind: 'responses'; readonly formId: string }
  /**
   * The **Testmodus** of a form — the preview in which an editor fills in their own
   * form.
   *
   * Under the form like the builder and the responses, and **never under the
   * public address**: that is the first of the three non-negotiable
   * boundaries of Konzept no. 28. A „mit Beispielwerten füllen" button on
   * `/f/<Adresse>` would be a tool for littering the evaluation — the
   * Testmodus is therefore a view of its own behind the login, not a
   * switch that a feature passes through the public route.
   */
  | { readonly kind: 'preview'; readonly formId: string }
  | { readonly kind: 'form-settings'; readonly formId: string }
  /**
   * Notifications of one form.
   *
   * Under the form, like the builder, the responses and the settings, because
   * that is what it is: a notification belongs to exactly one form and is
   * meaningless without it (composite key `(form_id, tenant_id)` in
   * `schema.prisma`).
   */
  | { readonly kind: 'notifications'; readonly formId: string }
  /**
   * Nutzerrechte **per form**.
   *
   * Under the form, like the builder and the notifications, and for the same
   * reason: a restriction is `(form_id, user_id)` and is meaningless without the
   * form. It is also where the handoff's subheader puts it („☷ Nutzerrechte"),
   * next to the other five entries of the current form.
   *
   * Not to be confused with `tenant-members` below — that one is the list of
   * *people in the organisation*, this one is what one of them may do on one form. The
   * two pages link to each other and are one segment apart, which is why the
   * addresses say `forms/…` and `admin/…` rather than both saying
   * „nutzerrechte" in the same place.
   */
  | { readonly kind: 'form-members'; readonly formId: string }
  /**
   * The mail log — **tenant-wide**, with an optional
   * prefilter on the form one arrives from.
   *
   * The address is `/mail-log` and **not**
   * `/forms/:id/mail-log`, and that is the decision of Konzept no. 32
   * made visible: the log is one list per organisation. A mail whose form has since
   * been deleted still has a row (`form_id` is `SetNull`), and a per-form
   * address would have no place to show it — it would be a line nobody can
   * reach about an address somebody was written to.
   *
   * The prefilter is a second segment, `/mail-log/<formId>`, so
   * `formId: null` is the whole log and clearing the filter is a navigation
   * that a shared link and the back button both reproduce. Deliberately not a
   * query parameter: this router reads `window.location.pathname` only
   * (`use-route.ts`), so a `?form=` would be a filter the address bar shows and
   * the application does not see.
   *
   * The **status** filter of the KPI tiles is not in the address at all — it is
   * view state, changes on every click, and belongs to the view that renders the tiles.
   */
  | { readonly kind: 'mail-log'; readonly formId: string | null }
  /**
   * The tenant administration — **three tabs, three sibling addresses** (the middle one arrived early).
   *
   * When only the middle tab existed, the comment here said the address was
   * `/admin/form-defaults` and **not** `/admin/tenant` with a tab
   * parameter, because an address implying a tab bar would promise two tabs that
   * did not exist — and that „when they arrive they can take `/admin/…`
   * addresses of their own". They have arrived, and they do: the shape that was
   * predicted is the shape being built, so the earlier decision is confirmed
   * rather than reversed.
   *
   * **Why siblings and not one address with a tab segment**, now that there are
   * three of them: a tab is a *place*, not a mode. Somebody links a colleague to
   * the group editor, comes back to it from a form's Nutzerrechte page, and
   * presses the back button expecting the tab they came from — all three need
   * the tab to be in the address. A `?tab=` query would not do it either: this
   * router reads `window.location.pathname` only (`use-route.ts`), so a query
   * parameter would be a state the address bar shows and the application does
   * not see. What a tab segment (`/admin/tenant/groups`) would add over
   * three siblings is a shared prefix and one more thing to parse; what it would
   * cost is the existing address, which E2E cases and links already use.
   *
   * **None of the three names an organisation**, and that is deliberate rather than
   * incidental: they are the *active* organisation's pages, exactly as
   * `GET /api/tenant/form-defaults` carries no tenant in its path (the requirement — „eine Grenze, die man gar nicht adressieren kann, ist stärker als
   * eine, die man adressiert und abgewiesen bekommt"). „Verwalten" in the
   * superadmin overview therefore switches the active Organisation and then opens these
   * pages; it does not address a stranger's Organisation from the browser.
   */
  | { readonly kind: 'tenant-appearance' }
  | { readonly kind: 'tenant-form-defaults' }
  | { readonly kind: 'tenant-members' }
  /**
   * The organisation's own sending identity (ADR-0013) — the **fourth** sibling of the tenant administration, added after
   * the other three shipped. Same reasoning as its siblings: a tab is a place,
   * not a mode, so it gets its own address rather than a `?tab=` query the
   * back button cannot see (`window.location.pathname` only,
   * `use-route.ts`).
   */
  | { readonly kind: 'tenant-mail' }
  /**
   * The **AI switch of this organisation** — the fifth tab (ADR-0025).
   *
   * The same reasoning as with the four siblings: a tab is a *place*, not a
   * mode. It arrived with the assistant, and **not** merely so that the
   * assistant has somewhere to lead to: the route
   * `PUT /ai/tenant-settings` had existed since ADR-0015, and it had not a
   * single surface in `apps/web/src`. A setting one sees only
   * once in the assistant is no setting.
   */
  | { readonly kind: 'tenant-ai' }
  /** The legal texts of this organisation — the sixth tab (ADR-0028). */
  | { readonly kind: 'tenant-legal-settings' }
  /**
   * The **initial setup of an organisation** (ADR-0025) — the assistant that
   * walks once through all settings of this organisation.
   *
   * **One address, unlike the Erstinbetriebnahme** (ADR-0022 no. 1, where
   * explicitly *none* was assigned): there is no session, no
   * shell and no second page there, here there is all of it. The flow has to
   * be leaveable, findable again and operable with the back button —
   * only an address can do that.
   *
   * It **names no organisation**, just as its four siblings do not:
   * what is meant is always the active one, and every route behind it resolves
   * it from the session.
   */
  | { readonly kind: 'tenant-setup' }
  /**
   * **The system administration — four tabs, four sibling addresses**
   * (finding 16).
   *
   * Until then there were three separate areas: the superadmin overview, the
   * „Betrieb" and the „Systemeinstellungen" with two tabs of their own, each
   * under an address of its own. Three entries in the header navigation for
   * a single role, and none of the three of any use without the others —
   * whoever creates organisations looks right afterwards whether the mail delivery
   * runs. They are now **one** place with four tabs: *Organisationen*,
   * *Überwachung*, *Mailserver*, *KI*.
   *
   * „Betrieb" thereby means **Überwachung**: the page operates nothing, it
   * watches. What it shows are queue, storage, AI consumption and
   * background runs against their thresholds — numbers to look at, no buttons
   * to intervene with.
   *
   * **Why four siblings and not one address with `?tab=`** — the same
   * reasoning the tenant administration gives above: a tab is a *place*.
   * A bookmark on the Überwachung, a link to a colleague and the
   * back button all need it in the address, and this router reads
   * `window.location.pathname` only (`use-route.ts`).
   *
   * **The first tab is the bare address** `/admin/system` and has
   * no sub-path of its own. Two addresses for one tab (that is how it stood in
   * the old „Systemeinstellungen", where the root and its mail sub-path showed
   * the same) are one address too many: they split bookmarks and history for
   * nothing.
   *
   * Die alten Adressen wurden bis Review-Runde 4 weitergeleitet; seit dem
   * harten Schnitt auf englische Pfade (Nr. 8) gibt es keine
   * Weiterleitungstabelle mehr — die Begründung steht dort, wo sie stand.
   */
  | { readonly kind: 'system-tenants' }
  | { readonly kind: 'system-monitoring' }
  | { readonly kind: 'system-mail' }
  | { readonly kind: 'system-templates' }
  | { readonly kind: 'system-ai' }
  /** The legal texts of the installation — the sixth tab (ADR-0028). */
  | { readonly kind: 'system-legal-settings' }
  /** Who carries the system administration — the seventh tab (ADR-0029). */
  | { readonly kind: 'system-superadmins' }
  /**
   * The trash (handoff §Screens/Views 10).
   *
   * Under `/admin/` like the superadmin overview and for the same
   * reason: what separates it from the pages beside it is not the address but
   * who may open it, decided by `RequirePermission('canBuild')` on the four
   * routes behind it (`TrashController`, `FormsController`) — „löschen darf,
   * wer bauen darf" . The navigation entry appears only with
   * that right; the routes answer 403 either way.
   */
  | { readonly kind: 'trash' }
  /** Rendered outside the shell and before the session check. */
  | { readonly kind: 'public-form'; readonly slug: string }
  /**
   * „Bearbeiten nach Absenden" — the address a participant is
   * handed on the confirmation page and in the confirmation mail.
   *
   * Outside the shell and before the session check, exactly like the fill-in
   * address, and for the same reason: whoever follows this link has no account.
   * The token is the whole capability; there is no form id and no organisation in the
   * address, so nothing here has to be resolved before the server is asked.
   */
  | { readonly kind: 'response-edit'; readonly token: string }
  /**
   * *Zwischenspeichern* resumed — `/e/<token>`.
   *
   * Outside the shell and before the session check, exactly like the fill-in
   * and the edit address: whoever follows this link has no account. The token
   * is the whole capability; there is no form id, no organisation and no slug in the
   * address (`RESPONSE_DRAFT_SEGMENT`'s own doc comment) — everything else is
   * looked up from it.
   */
  | { readonly kind: 'response-draft'; readonly token: string }
  /**
   * One's own profile — name, password and one's own sessions
   * (findings 12 and 17).
   *
   * **Not under `/admin/`**, although the other forms one fills in stand
   * there: what `/admin/` connects is "I decide about
   * others" — an organisation, its groups, its members, the
   * installation. This page decides about **nobody else**; it has
   * no right as a precondition, every logged-in person may open it, and
   * the routes behind it do not even know a parameter for a stranger's account.
   * A short address of its own says that without having to explain it.
   */
  | { readonly kind: 'profile' }
  /**
   * Redeeming a reset link — `/password/<token>` (ADR-0020).
   *
   * Outside the shell and **before** the session check, like the public
   * fill-in address and the two participant addresses: whoever follows this link
   * is precisely *not* getting at their login — that is the whole occasion.
   * Putting it behind the login would be the door one locks in front of the
   * key.
   *
   * The token is the whole capability: no id, no organisation, no
   * address in this URL.
   */
  | { readonly kind: 'password-reset'; readonly token: string }
  /**
   * Redeeming an **invitation link** — `/invitation/<token>` (ADR-0024).
   *
   * The same situation as above and the same short circuit before the
   * session check. What distinguishes them is **the wording alone**: „Neues
   * Passwort vergeben" is the wrong sentence for somebody who never had one.
   * The server sees no difference — both pages redeem through
   * the same route, and a human who rewrites the address by hand
   * gets the same answer in different words.
   */
  | { readonly kind: 'account-invitation'; readonly token: string }
  /**
   * **The legal-text pages** (ADR-0028) — outside the shell and **before** the
   * session check, like the three participant addresses above.
   *
   * The reason is even sharper here than there: § 18 Abs. 1 MStV demands
   * „ständig verfügbar", Art. 13 Abs. 1 DSGVO „zum Zeitpunkt der Erhebung".
   * A login mask in front of an imprint would be no imprint.
   *
   * The translation from the address segment to the key in the contract
   * (`imprint`, …) stands **once**, in `@formsache/shared`.
   */
  | { readonly kind: 'system-legal'; readonly page: SystemLegalPage }
  /**
   * The legal texts of one organisation — `/o/<kurzname>/…`.
   *
   * **The short name and not the slug of a form**: a slug is an
   * access credential from the CSPRNG, and a legal document under an address that
   * cannot be guessed contradicts „leicht zugänglich" (Art. 12 Abs. 1
   * DSGVO). The reasoning is written out in
   * `docs/legal/README.md` 5.2 and once more at `LEGAL_ORG_SEGMENT`.
   */
  | {
      readonly kind: 'tenant-legal';
      readonly shortName: string;
      readonly page: TenantLegalPage;
    }
  /** Licences and copyright — **fixed in the code**, with no document behind it. */
  | { readonly kind: 'licences' }
  | { readonly kind: 'not-found'; readonly path: string };

/**
 * The form a route is about, or `null` when it is about none.
 *
 * What „Aktuelles Formular" in the handoff's navigation means, answered in one
 * place: the sub-navigation appears on exactly these addresses, and the mobile
 * sheet uses the same answer, so the two cannot disagree about whether there is
 * a current form.
 *
 * The mail log counts **only with its prefilter**. Without one it is the
 * whole organisation's log and belongs to no form — offering „Bearbeiten"
 * next to it would have to guess which one.
 */
export function routeFormId(route: Route): string | null {
  switch (route.kind) {
    case 'builder':
    case 'preview':
    case 'responses':
    case 'form-settings':
    case 'notifications':
    case 'form-members':
      return route.formId;
    case 'mail-log':
      return route.formId;
    default:
      return null;
  }
}

/** Path of the builder for one form — the single place this URL is spelled. */
export function builderPath(formId: string): string {
  return `/forms/${encodeURIComponent(formId)}`;
}

/** Path of the Testmodus of one form — spelled once. */
export function previewPath(formId: string): string {
  return `/forms/${encodeURIComponent(formId)}/preview`;
}

/** Path of the responses table of one form. */
export function responsesPath(formId: string): string {
  return `/forms/${encodeURIComponent(formId)}/responses`;
}

/** Path of the settings of one form. */
export function formSettingsPath(formId: string): string {
  return `/forms/${encodeURIComponent(formId)}/settings`;
}

/** Path of the notifications of one form. */
export function notificationsPath(formId: string): string {
  return `/forms/${encodeURIComponent(formId)}/notifications`;
}

/** Path of the per-form user rights. */
export function formMembersPath(formId: string): string {
  return `/forms/${encodeURIComponent(formId)}/members`;
}

/**
 * Path of the mail log — the whole organisation's log, or the
 * same log prefiltered on the form one arrives from.
 */
export function mailLogPath(formId?: string): string {
  return formId === undefined
    ? MAIL_LOG_PATH
    : `${MAIL_LOG_PATH}/${encodeURIComponent(formId)}`;
}

/**
 * Public address of a published form — and of one submitted answer.
 *
 * **Re-exported from `@formsache/shared` rather than spelled here** . The server has to build the same addresses as absolute
 * links, for the confirmation and for the mail delivery, and a second
 * spelling in the API would be a link that stops matching this route the day
 * somebody renames it — a failure that shows up in a stranger's inbox, where it
 * cannot be taken back.
 */
export {
  accountInvitationPath,
  passwordResetPath,
  publicFormPath,
  responseDraftPath,
  responseEditPath,
  /**
   * The addresses of the legal-text pages — passed through from
   * `@formsache/shared` and **not** spelled here, for the same reason as
   * the five above: the server builds the same addresses as absolute links
   * (in the footer of every template), and a second spelling would be a
   * link that stops being right the day somebody renames it.
   */
  systemLegalPath,
  tenantLegalPath,
  LICENCES_PATH,
} from '@formsache/shared';

export const DASHBOARD_PATH = '/';

/** One's own profile — see the route for why not under `/admin/`. */
export const PROFILE_PATH = '/profile';

/**
 * The three tabs of the tenant administration, in the order the
 * segmented control shows them.
 *
 * `TENANT_FORM_DEFAULTS_PATH` is unchanged and stays the middle one: it has been
 * in use, E2E cases and links point at it, and a rename would break
 * them for nothing.
 */
export const TENANT_APPEARANCE_PATH = '/admin/appearance';
export const TENANT_FORM_DEFAULTS_PATH = '/admin/form-defaults';
export const TENANT_MEMBERS_PATH = '/admin/members';

/** The fourth sibling — the organisation's own sending identity. */
export const TENANT_MAIL_PATH = '/admin/mail';

/** The fifth — this organisation's own AI switch (ADR-0025). */
export const TENANT_AI_PATH = '/admin/ai';

/** The sixth — the legal texts of this organisation (ADR-0028). */
export const TENANT_LEGAL_SETTINGS_PATH = '/admin/legal';

/**
 * The initial setup of an organisation (ADR-0025).
 *
 * Not a tab of the organisation administration but a flow **above** them —
 * which is why it stands beside and not below `/admin/…`'s tabs.
 */
export const TENANT_SETUP_PATH = '/admin/setup';

/** The trash. */
export const TRASH_PATH = '/admin/trash';

/**
 * The tabs of the system administration, in the order in which the tab bar
 * shows them (finding 16; *Vorlagen* since ADR-0022, continuation 2026-08-18).
 *
 * The first carries the bare address; the other three hang one segment
 * below it. Why four addresses and no `?tab=`: see the route itself.
 */
export const SYSTEM_PATH = '/admin/system';
export const SYSTEM_MONITORING_PATH = '/admin/system/monitoring';
export const SYSTEM_MAIL_PATH = '/admin/system/mail';
/**
 * The notification templates of the installation.
 *
 * The tab arrived with the write path (ADR-0022, continuation 2026-08-18): the
 * column was read until then and written by nothing, so there was also
 * nothing to show. It has an address of its own and not merely a step in the
 * assistant, because a text one can change exactly once in the life of an
 * installation is no text one can change.
 */
export const SYSTEM_TEMPLATES_PATH = '/admin/system/templates';
/**
 * ⚠️ **„KI" is a short word, and Playwright matches names as a substring.**
 * The tab was therefore once called *„KI-Anbieter"*; it is now called *„KI"*, because
 * the four tabs are read together and three of them are one word. Whoever
 * renames something here looks for their word in `e2e/` and
 * `apps/web/**\/*.test.tsx` first.
 */
export const SYSTEM_AI_PATH = '/admin/system/ai';

/**
 * The legal texts of the installation (ADR-0028) — the sixth tab.
 *
 * An address of its own and not merely a step in the assistant, for the same
 * reason as with the templates: an imprint goes out of date, and a text one can
 * change exactly once is none one can change.
 */
export const SYSTEM_LEGAL_SETTINGS_PATH = '/admin/system/legal';

/**
 * Who carries the system administration (ADR-0029) — the seventh tab.
 *
 * An address of its own and no section of the *Organisationen* tab: what is
 * administered here hangs on **no** organisation. `is_superadmin` is on
 * the account, not on a membership, and a section below the list
 * of the organisations claimed the opposite.
 */
export const SYSTEM_SUPERADMINS_PATH = '/admin/system/superadmins';

/** First segment of the mail log — spelled once. */
export const MAIL_LOG_PATH = '/mail-log';

/**
 * **Es gibt keine Weiterleitungstabelle mehr** (Review-Runde 4 Nr. 8).
 *
 * Hier stand `LEGACY_PATHS` — fünf alte Adressen der Systemverwaltung, die
 * seit ihrer Umbenennung auf die neuen zeigten, damit Lesezeichen und
 * verschickte Links nicht auf die 404-Seite fallen.
 *
 * Sie ist fort, weil dieselbe Review-Runde, die **alle** Pfade auf Englisch
 * gezogen hat, den harten Schnitt ausdrücklich gewählt hat: kürzerer Code,
 * eine Wahrheit über jede Adresse, und keine Tabelle, die mit jeder weiteren
 * Umbenennung wächst und die niemand je wieder aufräumt.
 *
 * ⚠️ **Was das kostet, steht hier, damit es nicht überrascht.** Ein bereits
 * verschickter **Einladungs- oder Kennwortlink** trägt `/invitation/<token>`
 * bzw. `/password/<token>` und läuft ab jetzt in die 404-Seite. Die Token
 * selbst leben weiter (die Route dahinter ist unverändert), es muss also
 * niemand ein Konto neu anlegen — die Mail muss neu verschickt werden. Wer
 * eine Installation aktualisiert, verschickt offene Einladungen also am
 * besten noch einmal.
 *
 * Öffentliche Ausfüll-Adressen (`/f/`, `/a/`, `/e/`) sind **nicht** betroffen:
 * sie waren nie deutsch.
 */

/**
 * **Where a freshly logged-in person lands** (findings 15 and 26).
 *
 * For everybody the dashboard — except for a superadmin **without any
 * membership**. They need none: the superadmin property hangs on the
 * person, not on an organisation, and the architecture already carries that.
 * In practice they nevertheless landed on a dashboard that says „Kein Tenant
 * ausgewählt" and shows nothing else, because the server puts a session on an
 * organisation only with **exactly one** membership
 * (`deriveActiveTenant`). They found their working pages only through the
 * header navigation.
 *
 * Whoever has no membership has nothing to do on the dashboard — it is
 * the list of one organisation's forms, and there is none. The
 * system administration is their start page, the way the dashboard is for everybody
 * else.
 *
 * **No right is decided here.** A superadmin without a membership
 * reaches the same pages as before; they only arrive at a different one. The
 * boundary remains the `SuperadminGuard` behind the routes.
 */
export function startPath(user: {
  readonly isSuperadmin: boolean;
  readonly membershipCount: number;
}): string {
  return user.isSuperadmin && user.membershipCount === 0
    ? SYSTEM_PATH
    : DASHBOARD_PATH;
}

/**
 * Parses a pathname into a route.
 *
 * A pure function over a string, so the whole routing table is testable
 * without a DOM — which is the point of keeping it separate from the hook.
 */
export function parseRoute(pathname: string): Route {
  const segments = pathname
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => segment !== '');

  if (segments.length === 0) {
    return { kind: 'dashboard' };
  }

  const [first, second] = segments;

  if (first === 'forms' && second !== undefined && segments.length === 2) {
    return { kind: 'builder', formId: second };
  }

  if (
    first === 'forms' &&
    second !== undefined &&
    segments.length === 3 &&
    segments[2] === 'responses'
  ) {
    return { kind: 'responses', formId: second };
  }

  // The requirement — the Testmodus.
  if (
    first === 'forms' &&
    second !== undefined &&
    segments.length === 3 &&
    segments[2] === 'preview'
  ) {
    return { kind: 'preview', formId: second };
  }

  if (
    first === 'forms' &&
    second !== undefined &&
    segments.length === 3 &&
    segments[2] === 'settings'
  ) {
    return { kind: 'form-settings', formId: second };
  }

  // The requirement — the notifications of one form.
  if (
    first === 'forms' &&
    second !== undefined &&
    segments.length === 3 &&
    segments[2] === 'notifications'
  ) {
    return { kind: 'notifications', formId: second };
  }

  // The requirement — the per-form user rights.
  if (
    first === 'forms' &&
    second !== undefined &&
    segments.length === 3 &&
    segments[2] === 'members'
  ) {
    return { kind: 'form-members', formId: second };
  }

  // The three tabs of the tenant administration as three sibling
  // addresses — see the comment on the route union.
  if (first === 'admin' && segments.length === 2 && second === 'appearance') {
    return { kind: 'tenant-appearance' };
  }

  if (
    first === 'admin' &&
    segments.length === 2 &&
    second === 'form-defaults'
  ) {
    return { kind: 'tenant-form-defaults' };
  }

  if (first === 'admin' && segments.length === 2 && second === 'members') {
    return { kind: 'tenant-members' };
  }

  // The requirement — the organisation's own sending identity, the fourth sibling.
  if (first === 'admin' && segments.length === 2 && second === 'mail') {
    return { kind: 'tenant-mail' };
  }

  // The fifth tab (ADR-0025) — the AI switch of this organisation.
  if (first === 'admin' && segments.length === 2 && second === 'ai') {
    return { kind: 'tenant-ai' };
  }

  // The sixth tab of the organisation administration (ADR-0028).
  if (first === 'admin' && segments.length === 2 && second === 'legal') {
    return { kind: 'tenant-legal-settings' };
  }

  // The assistant (ADR-0025) — no tab, a flow above them.
  if (first === 'admin' && segments.length === 2 && second === 'setup') {
    return { kind: 'tenant-setup' };
  }

  // The requirement — the trash.
  if (first === 'admin' && segments.length === 2 && second === 'trash') {
    return { kind: 'trash' };
  }

  // Finding 16 — the four tabs of the system administration. The first carries the
  // bare address, the other three a segment below it.
  if (first === 'admin' && segments.length === 2 && second === 'system') {
    return { kind: 'system-tenants' };
  }

  if (first === 'admin' && segments.length === 3 && second === 'system') {
    if (segments[2] === 'monitoring') {
      return { kind: 'system-monitoring' };
    }
    if (segments[2] === 'mail') {
      return { kind: 'system-mail' };
    }
    if (segments[2] === 'templates') {
      return { kind: 'system-templates' };
    }
    if (segments[2] === 'ai') {
      return { kind: 'system-ai' };
    }
    // The sixth tab of the system administration (ADR-0028).
    if (segments[2] === 'legal') {
      return { kind: 'system-legal-settings' };
    }
    // The seventh tab of the system administration (ADR-0029).
    if (segments[2] === 'superadmins') {
      return { kind: 'system-superadmins' };
    }
  }

  // The requirement — the tenant-wide mail log, optionally prefiltered on
  // one form. One segment means „everything of this organisation".
  if (first === 'mail-log' && segments.length === 1) {
    return { kind: 'mail-log', formId: null };
  }
  if (first === 'mail-log' && second !== undefined && segments.length === 2) {
    return { kind: 'mail-log', formId: second };
  }

  // One's own profile (findings 12 and 17) — one segment, no id in it.
  if (segments.length === 1 && segments[0] === 'profile') {
    return { kind: 'profile' };
  }

  // The reset link (ADR-0020) — outside the shell, like the three
  // participant addresses below it.
  if (
    first === PASSWORD_RESET_SEGMENT &&
    second !== undefined &&
    segments.length === 2
  ) {
    return { kind: 'password-reset', token: second };
  }

  // The invitation link (ADR-0024) — the same capability, a different sentence.
  if (
    first === ACCOUNT_INVITATION_SEGMENT &&
    second !== undefined &&
    segments.length === 2
  ) {
    return { kind: 'account-invitation', token: second };
  }

  if (
    first === PUBLIC_FORM_SEGMENT &&
    second !== undefined &&
    segments.length === 2
  ) {
    return { kind: 'public-form', slug: second };
  }

  // The requirement — the edit address of one answer.
  if (
    first === RESPONSE_EDIT_SEGMENT &&
    second !== undefined &&
    segments.length === 2
  ) {
    return { kind: 'response-edit', token: second };
  }

  // The requirement — the resume address of one draft.
  if (
    first === RESPONSE_DRAFT_SEGMENT &&
    second !== undefined &&
    segments.length === 2
  ) {
    return { kind: 'response-draft', token: second };
  }

  // The legal texts (ADR-0028). The segment is **translated** and not
  // passed through: `systemLegalPageOf` is the allowlist, and what is not
  // on it is the 404 page like any other unknown address.
  if (segments.length === 1 && first !== undefined) {
    if (pathname.replace(/\/+$/u, '') === LICENCES_PATH) {
      return { kind: 'licences' };
    }
    const page = systemLegalPageOf(first);
    if (page !== null) {
      return { kind: 'system-legal', page };
    }
  }

  if (
    first === LEGAL_ORG_SEGMENT &&
    second !== undefined &&
    segments.length === 3
  ) {
    const page = tenantLegalPageOf(segments[2] ?? '');
    if (page !== null) {
      return { kind: 'tenant-legal', shortName: second, page };
    }
  }

  return { kind: 'not-found', path: pathname };
}
