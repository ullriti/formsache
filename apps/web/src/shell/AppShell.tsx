import type { ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { Permissions, SessionUser } from '@formsache/shared';

import { useFormPermissions } from '../api/forms';
import { ProductCopyright } from '../brand/ProductCopyright';
import { useLogout } from '../api/session';
import { useIsDesktop } from '../hooks/use-is-desktop';
import { documentTitle, routeTitle } from '../router/route-title';
import { DASHBOARD_PATH, routeFormId, startPath } from '../router/routes';
import { navigate, useRoute } from '../router/use-route';
import { tenantThemeStyle } from '../styles/tenant-theme';
import { BuilderView } from '../views/BuilderView';
import { DashboardView } from '../views/DashboardView';
import { FormMembersView } from '../views/FormMembersView';
import { MailLogView } from '../views/MailLogView';
import { NotificationsView } from '../views/NotificationsView';
import { PreviewView } from '../views/PreviewView';
import { ProfileView } from '../views/ProfileView';
import { ResponsesView } from '../views/ResponsesView';
import { SettingsView } from '../views/SettingsView';
import { SystemAdminView } from '../views/SystemAdminView';
import { TenantAdminView } from '../views/TenantAdminView';
import { TenantSetupView } from '../views/tenant-setup/TenantSetupView';
import { TrashView } from '../views/TrashView';
import { AiFormDialog } from './AiFormDialog';
import { AppHeader } from './AppHeader';
import { FormNav } from './FormNav';
import { MobileMenuSheet } from './MobileMenuSheet';

import './app-shell.css';

export interface AppShellProps {
  readonly user: SessionUser;
}

/**
 * Frame around every signed-in view: header, tenant theme, mobile menu.
 *
 * The active tenant comes from `activeTenantId`, resolved against the
 * memberships the server sent — never from a locally remembered choice. If the
 * two disagree (a membership was revoked while the tab was open) the shell
 * shows no tenant rather than one the session is not scoped to.
 */
/**
 * The landing place of the skip link **and** of the route announcement — one, not two
 * (a review finding).
 */
const MAIN_ID = 'inhalt';

export function AppShell({ user }: AppShellProps): ReactElement {
  const isDesktop = useIsDesktop();
  const route = useRoute();
  const [isMenuOpen, setMenuOpen] = useState(false);
  /**
   * Whether „✦ KI-Formular" is open.
   *
   * Shell state rather than a route, because the handoff draws it as a modal
   * over whatever is on screen — and because this application deliberately does
   * **not** load the result into the open builder, there is no document for an
   * address to name. Local `useState` and not the Zustand store: the store
   * holds the *document being edited*, and the one thing this dialogue must
   * never touch is that document.
   */
  const [isAiFormOpen, setAiFormOpen] = useState(false);
  const menuId = useId();
  /**
   * **The route change is announced, and the focus goes along**
   * (a review finding).
   *
   * Without that **nothing** happens for a screen reader on a change: the
   * focus stays on the clicked entry, the tab title stays put, and
   * the new view can only be found by searching for it.
   *
   * Three things, and all three are necessary: `document.title` (the browser
   * announces it on the change and it stands in the history list), the focus on
   * `<main>` (the next tab key thereby lands **in the content**, not
   * in the navigation again) and a polite live region (it says *where*
   * it went, without interrupting the reading).
   *
   * ⚠️ **Not on the first render.** On loading the browser reads the page
   * anyway; an announcement on top of it would be a repetition, and a focus
   * on `<main>` would take the skip link's sense away.
   */
  const mainRef = useRef<HTMLElement>(null);
  /**
   * The announced sentence **and how often it was announced** (a review finding).
   *
   * The counter is not bookkeeping, it is the announcement itself. `routeTitle`
   * is **static per route kind** (`route-title.ts` gives the reason why: the
   * heading arises from data that is not there yet at the change), so
   * a change within the same kind — mail log with a
   * form filter → without, `/forms/A` → `/forms/B` — means setting the
   * same sentence once more. A live region with an **unchanged** text node
   * is not read out again; it fell silent exactly where the announcement is
   * needed most. The same rule stands in full at `switchMessage`
   * (`QuestionProperties.tsx`), which solves it by taking the value into the
   * sentence — here that does not work, the sentence is the whole value.
   *
   * So two regions and an alternating target: the sentence lands alternately
   * in the one and in the other, the other one is emptied in the process. Both
   * stand in the tree from the first render onwards — a region that comes into
   * being only together with its text is new in the accessibility tree and is
   * frequently not announced at all (the same rule as with the deadline in `FormDeadline`).
   */
  const [routeAnnouncement, setRouteAnnouncement] = useState({
    text: '',
    seq: 0,
  });
  const previousRouteKey = useRef<string | null>(null);
  const routeKey = `${route.kind}:${routeFormId(route) ?? ''}`;
  useEffect(() => {
    document.title = documentTitle(route);
    if (previousRouteKey.current === null) {
      previousRouteKey.current = routeKey;
      return;
    }
    if (previousRouteKey.current === routeKey) {
      return;
    }
    previousRouteKey.current = routeKey;
    setRouteAnnouncement((previous) => ({
      text: routeTitle(route),
      seq: previous.seq + 1,
    }));
    mainRef.current?.focus();
    // `route` is the source of both statements; `routeKey` decides only whether
    // it was a *change*.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  /*
    Hier stand ein Effekt, der eine alte Adresse in der Adresszeile durch ihre
    neue ersetzte (Befund 16). Er ist mit der Weiterleitungstabelle
    verschwunden: Review-Runde 4 Nr. 8 hat alle Pfade auf Englisch gezogen und
    dafür ausdrücklich den harten Schnitt gewählt. Die Begründung und was das
    für bereits verschickte Links heißt, steht an der Stelle in
    `router/routes.ts`, wo `LEGACY_PATHS` stand.
  */

  /**
   * **The start page of a superadmin without an organisation** (findings 15 and 26).
   *
   * Where to is decided by `startPath` — here stands only the *when*: once, at
   * the building of the shell, and only when the address is the dashboard. That is
   * exactly "after the login" (and after a reload of `/`, which means the
   * same). A switch that struck on **every** visit of `/` would turn
   * the entry „Dashboard" in the header into a button that
   * does not do what is written on it.
   */
  const hasLanded = useRef(false);
  useEffect(() => {
    if (hasLanded.current) {
      return;
    }
    hasLanded.current = true;
    if (window.location.pathname !== DASHBOARD_PATH) {
      return;
    }
    navigate(
      startPath({
        isSuperadmin: user.isSuperadmin,
        membershipCount: user.memberships.length,
      }),
      { replace: true },
    );
    // Only at the build-up — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useLogout();
  /*
   * **„Andere Sitzungen beenden" no longer stands here** (finding 17).
   *
   * The button sat in the header and in the mobile menu, between „Angemeldet als
   * …" and „Abmelden": without context, without a session list, next to two things
   * that do nothing or end everything. The action is right — it is
   * the only handle against a betrayed password that a logged-in
   * person has themselves —, and it now stands where it is explicable: in the
   * profile, next to the password change (`ProfileView`). The state thereby lies
   * there too and no longer in the shell, which had to pass it through in two
   * places.
   */

  // Resizing past the breakpoint removes the hamburger; a sheet left open
  // would hang around with no way back to it.
  useEffect(() => {
    if (isDesktop) {
      setMenuOpen(false);
    }
  }, [isDesktop]);

  const activeMembership = user.memberships.find(
    (membership) => membership.tenant.id === user.activeTenantId,
  );
  const isDashboard = route.kind === 'dashboard';
  /**
   * Whether the header's „⚙ Organisations-Verwaltung" entry should read as current —
   * widened to all four siblings of the tenant administration (`tenant-mail` was
   * added afterwards), because the entry opens the first of them (`TENANT_APPEARANCE_PATH`) and
   * must not go dark the moment somebody switches to one of the other tabs
   * inside that view.
   */
  const isTenantDefaults =
    route.kind === 'tenant-form-defaults' ||
    route.kind === 'tenant-appearance' ||
    route.kind === 'tenant-members' ||
    route.kind === 'tenant-mail' ||
    route.kind === 'tenant-ai' ||
    route.kind === 'tenant-legal-settings' ||
    route.kind === 'tenant-setup';
  /**
   * Whether one of the **four** tabs of the system administration is open (finding 16) —
   * the same reasoning that `isTenantDefaults` gives for the tenant administration:
   * the one entry in the header opens the first tab and must not
   * go dark the moment somebody switches inside the view to
   * another one.
   *
   * It was once threefold — `isSuperadminOverview`, `isOps` and
   * `isSystemSettings` for three entries side by side. One entry, one marker.
   */
  const isSystemAdmin =
    route.kind === 'system-tenants' ||
    route.kind === 'system-monitoring' ||
    route.kind === 'system-mail' ||
    route.kind === 'system-templates' ||
    route.kind === 'system-ai' ||
    route.kind === 'system-legal-settings' ||
    route.kind === 'system-superadmins';
  /** Whether the trash is the open route. */
  const isTrash = route.kind === 'trash';
  // Straight from the server's answer for the **active** membership, never from
  // a remembered choice: showing an entry the session is not scoped to would be
  // showing a permission nobody granted.
  const canManageSettings =
    activeMembership?.permissions.canManageSettings ?? false;
  /**
   * `can_build` of the active membership — and the **one** of the five flags
   * that is still read Organisation-wide here, deliberately: it gates „+ Neues
   * Formular" on the dashboard, and creating a form is not an act on any form,
   * so no per-form restriction can speak about it (`POST /api/forms` carries
   * `@NoFormIdInRequest`). Everything that *is* about the current form reads
   * {@link formPermissions} below.
   */
  const canBuild = activeMembership?.permissions.canBuild ?? false;
  /**
   * Whether this installation has the KI-Formularerstellung (ADR-0015 no. 9).
   *
   * Straight off the session payload, like every other fact the shell acts on
   * — it is the *same* `aiAvailable(env)` the guard in front of the route
   * reads, so the entry and the route cannot disagree. No fallback: the field
   * is required on the wire, so an answer that does not carry it fails to
   * parse long before it reaches here.
   */
  const aiFormsAvailable = user.aiFormsAvailable;
  /** The form the current address is about — what „Aktuelles Formular" means. */
  const formId = routeFormId(route);
  /**
   * …and the same five flags **for that one form** (the requirement no. 3).
   *
   * The membership's flags are Organisation-wide; a per-form cap lowers the role on one
   * form and leaves the membership untouched. Everything on this screen that is
   * *about the current form* — the subheader, the mobile sheet's „Aktuelles
   * Formular", the builder's save button, the export — therefore reads these
   * and no longer the ones above.
   *
   * **The fallback while the list is pending or failed is the membership**,
   * not „nothing": those flags are the upper bound of what a cap could leave
   * (a restriction only ever intersects, `FormRestriction.capPermissions`), so
   * the fallback can never show more than the old code already showed, and
   * it keeps the subheader from blinking out of existence on every first
   * paint. That reasoning holds only for *not knowing yet* — once the list has
   * loaded, `useFormPermissions` itself tells a present form from an absent
   * one and returns no-permissions rather than `undefined` for the latter, so
   * this fallback no longer applies to a form the list ruled out (locked out
   * by `accessRevoked`, or someone else's). Neither is a boundary: every route
   * asks its guard regardless (`CONTRIBUTING.md`).
   */
  const membershipPermissions: Permissions = activeMembership?.permissions ?? {
    canBuild: false,
    canViewResponses: false,
    canExport: false,
    canManageSettings: false,
    canManageFormSettings: false,
    canManageUsers: false,
  };
  // `null` without a tenant scope as well as without a form: every
  // tenant-bound request answers 403 unscoped, and asking anyway would turn a
  // state the app can explain into an error it cannot (the reason
  // `DashboardView` guards its own `useForms` the same way).
  const formPermissions =
    useFormPermissions(activeMembership === undefined ? null : formId) ??
    membershipPermissions;

  const onLogout = (): void => {
    logout.mutate();
  };

  return (
    <div
      className={isDesktop ? 'app-shell' : 'app-shell app-shell--compact'}
      // The tenant axes of `tokens.css`, written as inline custom properties
      // on the scope element — the whole subtree resolves against them.
      // The tenant tokens of `tokens.css` are declared for this element
      // too — without the marker the axes below would be set and nothing would
      // read them.
      data-tenant-theme=""
      style={
        activeMembership === undefined
          ? undefined
          : tenantThemeStyle(activeMembership.tenant.branding)
      }
    >
      {/*
        **The skip link** (a review finding). axe' `bypass` rule was green,
        because there is a `<main>` — in reality it is around fourteen tab jumps
        through header and navigation before somebody reaches the content with
        the keyboard, and that anew on **every** view.

        Visible only in focus (`app-shell__skip`), first focusable
        element of the tree, and it points at the same `<main>` on which the
        route announcement sets the focus — one landing place, not two.
      */}
      <a className="app-shell__skip" href={`#${MAIN_ID}`}>
        Zum Inhalt springen
      </a>

      {/*
        The announcement itself — polite, so that it does not interrupt a running
        reading, and outside `<main>`, so that the focus change does not
        tear it along with it.

        **Two regions, written alternately** — the docblock of
        `routeAnnouncement` says why: twice the same sentence in the *same*
        region is no change of the text node and is not read out.
      */}
      <p className="app-shell__route-announcement" role="status">
        {routeAnnouncement.seq % 2 === 1 ? routeAnnouncement.text : ''}
      </p>
      <p className="app-shell__route-announcement" role="status">
        {routeAnnouncement.seq % 2 === 0 ? routeAnnouncement.text : ''}
      </p>

      <AppHeader
        userName={user.name}
        activeTenant={activeMembership?.tenant}
        memberships={user.memberships}
        activeTenantId={user.activeTenantId}
        isDesktop={isDesktop}
        isDashboard={isDashboard}
        isTenantDefaults={isTenantDefaults}
        isSystemAdmin={isSystemAdmin}
        isTrash={isTrash}
        canManageSettings={canManageSettings}
        // `can_build` of the active membership — „löschen darf, wer bauen
        // darf"  gates the trash entry the same way it
        // already gated „+ Neues Formular" above.
        canBuild={canBuild}
        // Straight from `GET /auth/me`, like every other permission the shell
        // acts on — and it hangs on the **person**, not on the active Organisation
        // , which is why it does not come from a membership.
        isSuperadmin={user.isSuperadmin}
        isMenuOpen={isMenuOpen}
        menuId={menuId}
        onOpenMenu={() => {
          setMenuOpen(true);
        }}
        onLogout={onLogout}
        isLoggingOut={logout.isPending}
      />

      {logout.isError ? (
        <p className="app-shell__alert" role="alert">
          Das Abmelden ist fehlgeschlagen. Bitte versuche es erneut.
        </p>
      ) : null}

      {/*
        The form-context subheader of the handoff, shown only where there is a
        current form. On the compact layout the same entries live in the
        off-canvas sheet — built from the same `formNavEntries()` — so the row
        is not repeated above a 360 px viewport it would have to scroll.
      */}
      {isDesktop && formId !== null ? (
        <FormNav formId={formId} route={route} permissions={formPermissions} />
      ) : null}

      <main
        className="app-shell__main"
        id={MAIN_ID}
        tabIndex={-1}
        ref={mainRef}
      >
        {route.kind === 'builder' ? (
          <BuilderView
            formId={route.formId}
            canBuild={formPermissions.canBuild}
            /*
              The permanent deletion **and the renaming** of a template
              (no. 74) — from `membershipPermissions` and not from
              `formPermissions`, for the same reason as `canPurge` at the
              trash further below: a template belongs to the **Organisation**, its
              routes name no form (`@NoFormIdInRequest`), so
              no form restriction can speak about them. The pair is the
              signature of irreversible writing in this application
               — and renaming is irreversible for everybody except the
              renamer, because nothing holds the old name fast.
            */
            canManageTemplates={
              membershipPermissions.canBuild &&
              membershipPermissions.canViewResponses
            }
            /*
              „Aus diesem Formular aktualisieren" — the same pair,
              but from `formPermissions`. The route lies under
              `forms/:formId`, because it copies **this** form; with that
              the form restriction applies, and whoever is capped here gets
              403 or 404. To show organisation-wide rights would mean showing a button
              that does not work for precisely this person.
            */
            canUpdateTemplates={
              formPermissions.canBuild && formPermissions.canViewResponses
            }
            canManageFormSettings={formPermissions.canManageFormSettings}
          />
        ) : route.kind === 'preview' ? (
          /*
            The Testmodus — **inside**
            the shell and behind the login, unlike the public
            fill-in view, which `App` renders without the shell. That is the first of
            the three non-negotiable boundaries: the Testmodus is a view for
            editors of the organisation, not a switch on `/f/<Adresse>`.

            The organisation comes from the active membership — the same source from
            which the shell draws its own branding —, never from a
            public payload: that one would exist here only via the route which this
            view precisely does not call.

            `canBuild` **of this form** is passed in and enforced in the
            view (a follow-up, a review finding). Before that
            the promise "the Testmodus hangs on `canBuild`" hung on the
            navigation entry alone, and `/forms/<id>/preview` stood open via the
            address bar to everybody who may read the form at all. The
            boundary is still the guard in front of `GET /forms/:id` — this here is
            comfort, but comfort that says the same as the menu.
          */
          <PreviewView
            formId={route.formId}
            tenant={activeMembership?.tenant}
            canBuild={formPermissions.canBuild}
            canManageFormSettings={formPermissions.canManageFormSettings}
          />
        ) : route.kind === 'responses' ? (
          <ResponsesView
            formId={route.formId}
            canBuild={formPermissions.canBuild}
            canExport={formPermissions.canExport}
          />
        ) : route.kind === 'form-settings' ? (
          <SettingsView formId={route.formId} />
        ) : route.kind === 'notifications' ? (
          <NotificationsView
            formId={route.formId}
            tenantName={activeMembership?.tenant.name}
          />
        ) : route.kind === 'mail-log' ? (
          <MailLogView formId={route.formId} />
        ) : route.kind === 'form-members' ? (
          /*
            Nutzerrechte per form. Reachable
            only through `FormNav`'s new entry — no client-side gate here for
            the same reason as `SystemAdminView` below: the guard behind
            `GET /forms/:formId/members` is the boundary, this shell is not a
            second one.
          */
          <FormMembersView formId={route.formId} />
        ) : route.kind === 'tenant-setup' ? (
          /*
            **The assistant of an organisation** (ADR-0025). It stands *in* the
            shell and not in front of it: there is a session, a header and a
            dashboard, and precisely those are the way out that keeps it from
            locking somebody in. The rights go in as `membershipPermissions`
            — not as a boundary (the guards decide), but so that
            it visibly skips a step that this role may not take
            instead of showing a form that says 403 on saving.
          */
          <TenantSetupView
            tenantId={activeMembership?.tenant.id}
            tenantName={activeMembership?.tenant.name}
            tenantShortName={activeMembership?.tenant.shortName}
            permissions={membershipPermissions}
            currentUserId={user.id}
            currentUserEmail={user.email}
          />
        ) : route.kind === 'tenant-appearance' ||
          route.kind === 'tenant-form-defaults' ||
          route.kind === 'tenant-members' ||
          route.kind === 'tenant-mail' ||
          route.kind === 'tenant-ai' ||
          route.kind === 'tenant-legal-settings' ? (
          /*
            The five sibling addresses of the tenant administration (`tenant-mail`
            and `tenant-ai` added afterwards) share one view and one segmented control — see
            `TenantAdminView` for why the `form-defaults` tab embeds
            `TenantFormDefaultsView` unchanged rather than this shell rendering
            it on its own, as it did earlier.
          */
          <TenantAdminView
            tenantId={activeMembership?.tenant.id}
            tenantName={activeMembership?.tenant.name}
            tenantShortName={activeMembership?.tenant.shortName}
            currentUserId={user.id}
            currentUserEmail={user.email}
            tab={
              route.kind === 'tenant-appearance'
                ? 'appearance'
                : route.kind === 'tenant-members'
                  ? 'members'
                  : route.kind === 'tenant-mail'
                    ? 'mail'
                    : route.kind === 'tenant-ai'
                      ? 'ai'
                      : route.kind === 'tenant-legal-settings'
                        ? 'legal'
                        : 'form-defaults'
            }
          />
        ) : /*
            Rendered for whoever asks for the address, superadmin or not: the
            view puts the server's 403 on screen instead of this shell guessing
            at an answer. A client-side gate here would be a second authority
            over the same question, and the one that is wrong first is always
            the one that cannot see the session (`CONTRIBUTING.md`).

            The **four tabs of the system administration** (finding 16) are four
            addresses and one shell; which tab is open is said by the route
            and not by a state in the view. `activeTenantId` is the
            scope of the session, straight from `GET /auth/me`, so that the
            tab *Organisationen* marks its own row and no stranger's.
          */
        route.kind === 'system-tenants' ? (
          <SystemAdminView
            tab="tenants"
            activeTenantId={user.activeTenantId}
            currentUserId={user.id}
          />
        ) : route.kind === 'system-monitoring' ? (
          <SystemAdminView
            tab="monitoring"
            activeTenantId={user.activeTenantId}
            currentUserId={user.id}
          />
        ) : route.kind === 'system-mail' ? (
          <SystemAdminView
            tab="mail"
            activeTenantId={user.activeTenantId}
            currentUserId={user.id}
          />
        ) : route.kind === 'system-templates' ? (
          <SystemAdminView
            tab="templates"
            activeTenantId={user.activeTenantId}
            currentUserId={user.id}
          />
        ) : route.kind === 'system-ai' ? (
          <SystemAdminView
            tab="ai"
            activeTenantId={user.activeTenantId}
            currentUserId={user.id}
          />
        ) : route.kind === 'system-legal-settings' ? (
          <SystemAdminView
            tab="legal"
            activeTenantId={user.activeTenantId}
            currentUserId={user.id}
          />
        ) : route.kind === 'system-superadmins' ? (
          <SystemAdminView
            tab="superadmins"
            activeTenantId={user.activeTenantId}
            currentUserId={user.id}
          />
        ) : route.kind === 'trash' ? (
          /*
            Trash (handoff §Screens/Views 10) —
            rendered for whoever asks, same reasoning as `SystemAdminView`
            above: the guard behind `GET /trash` is the boundary, this shell
            is not a second one. The navigation entry is hidden without
            `canBuild` as a courtesy only (see `AppHeader`).

            `canPurge` is `membershipPermissions`, not `formPermissions`: the
            trash names no single form, and its stronger pair
             is an organisation-wide question the same way `canBuild`
            above already is.
          */
          <TrashView
            canPurge={
              membershipPermissions.canBuild &&
              membershipPermissions.canViewResponses
            }
          />
        ) : route.kind === 'profile' ? (
          /*
            One's own profile (findings 12 and 17). Without a rights check and without
            an organisation: the page decides about nobody else, and the
            routes behind it do not even know a parameter for a stranger's account.
          */
          <ProfileView user={user} />
        ) : route.kind === 'dashboard' ? (
          <DashboardView
            tenantName={activeMembership?.tenant.name}
            tenantCount={user.memberships.length}
            canBuild={canBuild}
            /*
              „✦ KI-Formular" stands since finding 18 **here** and no longer in
              the header: the button creates a form, exactly like „+ Neues
              Formular" beside it, and an entry in a navigation bar that
              does not navigate but opens a dialogue says the wrong thing
              about itself. The conditions have been dragged along — present instead of
              greyed out, where the installation has no key.
            */
            aiFormsAvailable={aiFormsAvailable}
            onOpenAiForm={() => {
              setAiFormOpen(true);
            }}
            /*
              The setup of this organisation (ADR-0025): either the
              invitation into the assistant or the list of open items, never
              both — which of the two, is decided by the state, and that is read by
              the view itself. From here come only the three details that
              this shell holds anyway.
            */
            tenantId={activeMembership?.tenant.id}
            permissions={activeMembership?.permissions}
          />
        ) : (
          /*
            Every other address. The public fill-in URL never reaches this
            branch — `App` renders it without the shell, before the session
            check — so what lands here is genuinely an address the
            application does not have. `path` is only carried by the
            `not-found` route; a `public-form` route reaching here would be a
            wiring mistake, and showing no address is the honest rendering of
            "we do not know what you asked for".
          */
          <NotFound
            path={route.kind === 'not-found' ? route.path : undefined}
          />
        )}
      </main>

      {/*
        **Die Software-Zeile steht auch im angemeldeten Teil**
        (Review-Runde 3 Nr. 9). Sie stand bis dahin nur unter den öffentlichen
        Ansichten — sichtbar also ausschließlich für Ausfüllende, während die
        Menschen, die täglich in der Anwendung arbeiten, nie erfuhren, welche
        Software sie bedienen und unter welcher Lizenz sie steht.

        **Außerhalb von `<main>`**, wie die Kopfzeile: sie gehört zur Seite und
        nicht zur Ansicht, und der Sprunglink zeigt weiterhin auf den einen
        Inhaltsbereich. Ein `<footer>` ohne `aria-label` ist hier richtig — es
        gibt genau einen, und er trägt keine Navigation, sondern einen Satz.

        Bewusst **nicht** die Rechtsfußzeile: Impressum und
        Datenschutzhinweise richten sich an Ausfüllende und werden im
        angemeldeten Teil über die Einstellungen gepflegt, nicht gelesen. Was
        beiden Seiten gemeinsam ist, ist allein die Nennung der Software.
      */}
      <footer className="app-shell__footer">
        <ProductCopyright />
      </footer>

      {!isDesktop && isMenuOpen ? (
        <MobileMenuSheet
          id={menuId}
          userName={user.name}
          memberships={user.memberships}
          activeTenantId={user.activeTenantId}
          isDashboard={isDashboard}
          isTenantDefaults={isTenantDefaults}
          isSystemAdmin={isSystemAdmin}
          isTrash={isTrash}
          canManageSettings={canManageSettings}
          canBuild={canBuild}
          isSuperadmin={user.isSuperadmin}
          formPermissions={formPermissions}
          formId={formId}
          route={route}
          onClose={() => {
            setMenuOpen(false);
          }}
          onLogout={onLogout}
          isLoggingOut={logout.isPending}
        />
      ) : null}

      {/*
        „✦ KI-Formular" — rendered **beside** `<main>`, never
        inside the view it covers, so nothing about it depends on which route
        is open. That is the structural half of „ein bestehender Entwurf wird
        nie ersetzt": the dialogue is not a part of the builder, holds no form
        id, and reaches the builder's store through no path at all.

        **The opener stands on the dashboard since finding 18**, next to „+ Neues
        Formular"; the dialogue itself stays here. That is no contradiction,
        but the same sentence: it does not belong in the view that it covers.

        The availability flag gates the mounting as well as the entry. Not
        because a state variable could be set without it — it cannot, the
        setter hangs on the gated button — but because a shell that keeps the
        pair in one place cannot grow a second opener that forgets the check.
      */}
      {aiFormsAvailable && isAiFormOpen ? (
        <AiFormDialog
          onClose={() => {
            setAiFormOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The 404 page.
 *
 * A real page rather than one line of text, because this is where a stale
 * bookmark, a link truncated by a mail client and a plain typo all end up.
 * „Diese Seite gibt es nicht" alone leaves someone wondering whether the
 * application is broken; the address, shown back to them, is the one piece of
 * information that says which of the three happened — and it is why the URL is
 * repeated here instead of only sitting in the address bar.
 */
function NotFound({
  path,
}: {
  readonly path: string | undefined;
}): ReactElement {
  return (
    <section className="not-found">
      <p className="not-found__code" aria-hidden="true">
        404
      </p>
      <h1 className="not-found__title">Diese Seite gibt es nicht.</h1>
      <p className="not-found__text">
        {path === undefined ? (
          'Die aufgerufene Adresse führt nirgendwohin.'
        ) : (
          <>
            Die Adresse <code className="not-found__path">{path}</code> führt
            nirgendwohin.
          </>
        )}{' '}
        Vielleicht ist der Link unvollständig kopiert oder ein Lesezeichen
        veraltet.
      </p>
      <button
        type="button"
        className="not-found__action"
        onClick={() => {
          navigate(DASHBOARD_PATH);
        }}
      >
        Zurück zum Dashboard
      </button>
    </section>
  );
}
