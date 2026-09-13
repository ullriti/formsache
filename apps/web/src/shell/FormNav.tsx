import type { ReactElement } from 'react';
import type { Permissions } from '@formsache/shared';

import type { Route } from '../router/routes';
import {
  builderPath,
  formMembersPath,
  formSettingsPath,
  mailLogPath,
  notificationsPath,
  previewPath,
  responsesPath,
} from '../router/routes';
import { navigate } from '../router/use-route';

import './form-nav.css';

/**
 * The handoff's **Subheader im Formular-Kontext** (Informationsarchitektur):
 * „Bearbeiten · Antworten · Benachrichtigungen · E-Mail-Versandprotokoll ·
 * Formular-Einstellungen · Nutzerrechte".
 *
 * Rendered by the shell for every address that is about one form, so the entries
 * are in one place rather than repeated as ad-hoc buttons in five views — which
 * is how „Benachrichtigungen" ends up reachable from three of them and not the
 * other two.
 *
 * ## „Vorschau" — present since concept no. 28
 *
 * It used to say here that the second half of the handoff's switch
 * „Bearbeiten / Vorschau" is **missing**, because there was no preview address: a
 * published form is filled in under its public address,
 * a draft had nothing to show, and an entry leading nowhere is worse
 * than none. Concept no. 28 has now decided the address, and in exactly
 * the shape that removes the old objection: the **Testmodus** is a view
 * for editors of the organisation over the *draft* — not a switch on
 * `/f/<address>`. So the entry leads somewhere, and it deliberately does not
 * lead to the public page.
 *
 * ## Rights
 *
 * Every entry is hidden without the permission the route behind it requires, as
 * the server reported it. That is a courtesy, not the boundary: the guards
 * answer 403 either way (`CONTRIBUTING.md`). Showing a door that is locked is how
 * a permission gets assumed to exist.
 *
 * The flags are the ones that apply to **this form** (the requirement no. 3),
 * not the organisation-wide ones off the session: a per-form cap lowers the role on one
 * form, and reading the membership here offered doors the guard then refused.
 *
 * **Four of the entries hang off `can_manage_form_settings`** — the right
 * ADR-0021 introduced: notifications, mail log,
 * form settings and Nutzerrechte. Until then `can_manage_settings` stood
 * there, and because the same right unlocks the *organisation-wide*
 * form standards, the Erscheinungsbild and SSO,
 * „editors may configure their form" would have unlocked the whole organisation
 * along with it. The separation exists for exactly that reason, and this menu is the
 * place where one sees it: the standard group `editor` holds the narrow right
 * and sees all six entries here — without the entry „Verwaltung" in the header,
 * which hangs off the wide one.
 *
 * „Bearbeiten" was the one entry that read no flag at all until a review found it —
 * it is the door to the builder, and `PUT /api/forms/:id` requires `canBuild`.
 * Somebody who may only read answers was walked into an editor that refuses to
 * save; the entry is now gated like every other. **Hidden, not disabled**, for
 * the reason this section already gives: a navigation bar is a list of doors,
 * and a locked one listed is worse than an absent one. Where the missing right
 * needs *saying* — the dashboard and the export — the view says it (see
 * `DashboardView`, `ResponsesView`).
 */
export interface FormNavProps {
  readonly formId: string;
  readonly route: Route;
  /**
   * The **effective** permissions on *this* form — `FormSummary.permissions`,
   * with any per-form cap already applied by the server (the requirement
   * no. 3).
   *
   * Deliberately one object rather than four loose booleans, and deliberately
   * not the membership's: this bar used to read the **Organisation-wide** flags off the
   * session, so somebody capped on one form to a role without `can_build` was
   * still offered „Bearbeiten" and got a 403 from behind it. A named type is
   * what keeps the next caller from handing the tenant-wide set back in.
   */
  readonly permissions: Permissions;
}

export function FormNav({
  formId,
  route,
  permissions,
}: FormNavProps): ReactElement {
  const entries = formNavEntries({ formId, permissions });

  // Gating „Bearbeiten" made an empty list reachable (a role with neither
  // `canBuild` nor any of the other three). An empty bar is a stripe of chrome
  // that says nothing — better no subheader at all.
  if (entries.length === 0) {
    return <></>;
  }

  return (
    <nav className="form-nav" aria-label="Aktuelles Formular">
      {entries.map((entry) => {
        const current = entry.kind === route.kind;
        return (
          <button
            key={entry.kind}
            type="button"
            className={
              current
                ? 'form-nav__item form-nav__item--current'
                : 'form-nav__item'
            }
            aria-current={current ? 'page' : undefined}
            onClick={() => {
              navigate(entry.path);
            }}
          >
            <span aria-hidden="true">{entry.icon} </span>
            {entry.label}
          </button>
        );
      })}
    </nav>
  );
}

/** One entry of the form context navigation. */
export interface FormNavEntry {
  /** The route kind this entry leads to — also what marks it as current. */
  readonly kind: Route['kind'];
  readonly label: string;
  readonly icon: string;
  readonly path: string;
}

/**
 * The entries a given membership may see, in the handoff's order.
 *
 * A pure function so both navigations — the desktop subheader and the mobile
 * sheet — build the same list from the same rules; two hand-written copies is
 * how one of them keeps offering an entry the other dropped.
 */
export function formNavEntries({
  formId,
  permissions,
}: {
  readonly formId: string;
  /** Effective on this form, never Organisation-wide — see {@link FormNavProps}. */
  readonly permissions: Permissions;
}): FormNavEntry[] {
  const { canBuild, canViewResponses, canManageFormSettings, canManageUsers } =
    permissions;
  const entries: FormNavEntry[] = [];

  if (canBuild) {
    entries.push({
      kind: 'builder',
      label: 'Bearbeiten',
      icon: '✎',
      path: builderPath(formId),
    });
  }

  // The requirement — the Testmodus, right beside „Bearbeiten", the way the
  // handoff's switch shows the two. **On `canBuild`**, not on
  // one of the settings rights: the view stands over the draft the
  // builder writes (`GET /forms/:id`), and whoever may not build has no
  // draft to check. What it additionally shows — presentation and
  // notifications — hangs off `canManageFormSettings` and is named in the
  // view itself, instead of hiding a second door here.
  //
  // The absence of this entry is no longer the only thing that keeps the Testmodus
  // away: `PreviewView` gets
  // `canBuild` and otherwise refuses itself. Previously the address bar was the
  // way past this `if`.
  if (canBuild) {
    entries.push({
      kind: 'preview',
      label: 'Vorschau',
      icon: '▷',
      path: previewPath(formId),
    });
  }

  if (canViewResponses) {
    entries.push({
      kind: 'responses',
      label: 'Antworten',
      icon: '▤',
      path: responsesPath(formId),
    });
  }

  if (canManageFormSettings) {
    entries.push({
      kind: 'notifications',
      label: 'Benachrichtigungen',
      icon: '✉',
      path: notificationsPath(formId),
    });
  }

  // The mail log needs **both** flags: its rows
  // carry participants' addresses and subjects rendered from answers, so
  // reading it is reading answers.
  if (canManageFormSettings && canViewResponses) {
    entries.push({
      kind: 'mail-log',
      label: 'E-Mail-Versandprotokoll',
      icon: '✉',
      path: mailLogPath(formId),
    });
  }

  if (canManageFormSettings) {
    entries.push({
      kind: 'form-settings',
      label: 'Formular-Einstellungen',
      icon: '⚙',
      path: formSettingsPath(formId),
    });
  }

  // Two rights open this entry, because two rights open the route:
  // `FormPermissionController` demands `@RequireAnyPermission` over
  // `FORM_MEMBERS_PERMISSIONS` — `canManageUsers` (the organisation's user
  // administration, narrowed to one form) **or** `canManageFormSettings`
  // (whoever configures a form also decides who works on it,
  // ADR-0021). Showing the door under the wrong flag would mean showing it to
  // somebody the 403 sends away — and showing it under too few flags
  // would mean hiding a right somebody has.
  if (canManageUsers || canManageFormSettings) {
    entries.push({
      kind: 'form-members',
      label: 'Nutzerrechte',
      icon: '☷',
      path: formMembersPath(formId),
    });
  }

  return entries;
}
