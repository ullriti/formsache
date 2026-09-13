import type { Route } from './routes';

/**
 * The name of a view — for `document.title` and for the announcement after a
 * route change (a review finding).
 *
 * ## Why this is a file at all
 *
 * The application switches views without a page load (ADR-0010). For a screen
 * reader that means: **nothing** happens. The focus stays on the element that
 * was clicked, the title of the browser tab stays as it is, and the new view
 * can only be found by searching for it. A page load does all of that by
 * itself — an SPA has to rebuild it.
 *
 * ## Why the names stand here and not in the views
 *
 * The heading of a view often arises out of loaded data („Antworten ·
 * Bestandsmeldung"), and that is not yet fixed at the moment of the switch. An
 * announcement that waits for data comes too late or not at all. These names
 * are therefore **static per route kind** — they say *where* one has arrived,
 * and the heading says afterwards *what* stands there.
 */
export const APP_TITLE = 'Formsache';

export function routeTitle(route: Route): string {
  switch (route.kind) {
    case 'dashboard':
      return 'Dashboard';
    case 'builder':
      return 'Formular bearbeiten';
    case 'responses':
      return 'Antworten';
    case 'preview':
      return 'Vorschau (Testmodus)';
    case 'form-settings':
      return 'Einstellungen des Formulars';
    case 'notifications':
      return 'Benachrichtigungen';
    case 'form-members':
      return 'Nutzerrechte des Formulars';
    case 'mail-log':
      return 'Versandprotokoll';
    case 'tenant-appearance':
      return 'Erscheinungsbild & Login';
    case 'tenant-form-defaults':
      return 'Formular-Standards der Organisation';
    case 'tenant-members':
      return 'Nutzerrechte';
    case 'tenant-mail':
      return 'Mailversand';
    case 'tenant-ai':
      return 'KI der Organisation';
    case 'tenant-legal-settings':
      return 'Rechtstexte der Organisation';
    case 'tenant-setup':
      return 'Organisation einrichten';
    case 'trash':
      return 'Papierkorb';
    // The four tabs of the system administration (finding 16). Each names
    // itself with the place in front of it: the tab title stands in the history
    // list, and „Mailserver" alone would stand there next to the „Mailversand"
    // of the organisation, without anything distinguishing the two.
    case 'system-tenants':
      return 'Systemverwaltung · Organisationen';
    case 'system-monitoring':
      return 'Systemverwaltung · Überwachung';
    case 'system-mail':
      return 'Systemverwaltung · Mailserver';
    case 'system-ai':
      return 'Systemverwaltung · KI';
    case 'system-legal-settings':
      return 'Systemverwaltung · Rechtstexte';
    case 'system-superadmins':
      return 'Systemverwaltung · Superadmins';
    case 'public-form':
      return 'Formular ausfüllen';
    // The public legal-text pages (ADR-0028). They name their genus and not
    // the operator: which name stands on the page is only known by the answer
    // of the server, and an announcement that waits for data comes too late.
    case 'system-legal':
      return route.page === 'imprint' ? 'Impressum' : 'Datenschutzerklärung';
    case 'tenant-legal':
      return route.page === 'imprint'
        ? 'Anbieterangaben'
        : 'Datenschutzhinweise';
    case 'licences':
      return 'Lizenzen und Urheberrecht';
    case 'response-edit':
      return 'Antwort bearbeiten';
    case 'response-draft':
      return 'Entwurf fortsetzen';
    case 'profile':
      return 'Mein Profil';
    case 'password-reset':
      return 'Neues Passwort vergeben';
    default:
      // No `never` proof: the route union grows, and a new entry should get
      // an announcement without a name instead of a compilation error.
      return APP_TITLE;
  }
}

/** The title of the browser tab: the view, then the application. */
export function documentTitle(route: Route): string {
  const name = routeTitle(route);
  return name === APP_TITLE ? APP_TITLE : `${name} · ${APP_TITLE}`;
}
