import { isStaleRevision } from '../api/forms';
import { ApiError } from '../api/http';
import type { SettingIssues } from './settings/SettingsControls';

/**
 * Turning a refused request into something an editor can act on — **the one
 * place an HTTP status becomes a German sentence.**
 *
 * It started as `settings/setting-issues.ts` for the three settings surfaces
 * and moved up here when new surfaces arrived with four more copies of the
 * same chain (a row of *Nutzerrechte je Formular*, the member list, „Person
 * hinzufügen", the group editor). Each copy told the statuses apart slightly
 * differently, and the differences were all invisible until the day one of them
 * reported a 409 as „unbekannter Fehler": the point of one module is not
 * tidiness, it is that „bitte neu laden", „das ist gerade nicht möglich" and
 * „bitte erneut versuchen" ask for three different reactions and must not be
 * able to drift into each other.
 */

/**
 * What a failed request was about — the parts that genuinely differ per
 * surface, and nothing that does not.
 *
 * The advice („bitte die markierten Felder prüfen", „bitte erneut versuchen")
 * is deliberately absent: it is the same advice whatever was being written, and
 * spelling it per surface is how the copies started.
 */
export interface ActionSubject {
  /**
   * The 403 in full. Here the whole sentence is right, because the surfaces
   * refuse for genuinely different reasons — a group permission in most of
   * them, the superadmin flag elsewhere.
   */
  readonly forbidden: string;
  /** Fallback: an unexpected status, a network error, a broken payload. */
  readonly failed: string;
  /** 409 — used only when the server sent no sentence of its own. */
  readonly conflict?: string;
  /**
   * 404 — and this one **wins over** the server's sentence where it is given.
   *
   * The 404s of this application are deliberately uninformative: „Organisation nicht
   * gefunden." is the same answer an organisation one may not enter and an organisation that does
   * not exist both get, because anything else would make the endpoint an
   * enumeration oracle (`session-tenant.controller.ts`). Repeating that
   * sentence on a page that is *showing* the organisation explains nothing; the surface
   * usually knows the reason and may say it.
   */
  readonly missing?: string;
  /** 422 — used only when the server sent no sentence of its own. */
  readonly invalid?: string;
}

/**
 * The message a refused request produces.
 *
 * **The server's own sentence wins on 409 and 422**: those refusals are decided
 * by a rule that lives on the server (the last administrator of an organisation, a group
 * that still has members, an OIDC account in an organisation without SSO), and a second
 * wording invented in the browser is a sentence that drifts away from the rule
 * it describes.
 *
 * The client's wording wins on 403, 400, 404 and 413 — the four where the
 * server has nothing specific to say: a guard answers 403 the same way
 * everywhere, a 400's detail is already on the fields ({@link fieldIssues}), a
 * 404 is kept vague on purpose (see {@link ActionSubject.missing}), and a 413
 * comes from the body limiter in `app-setup.ts` **before** any controller —
 * there is no sentence of the application's in it, only a status.
 */
export function actionErrorMessage(
  error: unknown,
  subject: ActionSubject,
): string {
  if (!(error instanceof ApiError)) {
    return subject.failed;
  }
  if (error.status === 403) {
    return subject.forbidden;
  }
  if (error.status === 400) {
    return 'Bitte die markierten Felder prüfen.';
  }
  /*
    **413 — and the advice must not be „nochmal"** (review finding of
    2026-08-19).

    The body limiter (100 KiB, `app-setup.ts`) sits as the first handler before the
    body parser; the answer therefore carries no sentence of the application, but
    only the status. Without this branch it fell through to `failed`, and on a
    save that means „Bitte erneut versuchen." — advice that
    fails the second time at the same limit just as much, because nothing has
    changed.

    Since ADR-0028 that is reachable at exactly one place with realistic
    numbers: a `PUT /api/forms/:id/settings` carries, besides the settings, a
    whole legal-text document (no. 7 of the ADR works it out — with
    three-byte characters the field limit suffices, because `LEGAL_TEXT_MAX`
    counts UTF-16 units and the limiter bytes). The sentence therefore names the
    shortening and says expressly that a second attempt changes nothing.
  */
  if (error.status === 413) {
    return 'Die Eingaben sind zusammen zu lang für einen Schreibvorgang. Bitte den längsten Text kürzen — ein erneuter Versuch mit demselben Inhalt scheitert genauso.';
  }
  if (error.status === 409) {
    return error.detail ?? subject.conflict ?? subject.failed;
  }
  if (error.status === 404) {
    return subject.missing ?? error.detail ?? subject.failed;
  }
  if (error.status === 422) {
    return error.detail ?? subject.invalid ?? subject.failed;
  }
  return subject.failed;
}

/**
 * Which document a failed **save** was about.
 *
 * A save differs from any other write in one point only: it carries a revision,
 * so its 409 is „jemand anderes war schneller" rather than „das geht nicht" —
 * and that is the one sentence a surface must not be able to collapse into the
 * generic one (Konzept no. 21).
 */
export interface SaveSubject {
  /**
   * Subject and verb of the 409, e.g. `'Das Formular wurde'` — followed by
   * „zwischenzeitlich von jemand anderem geändert …". Not the whole sentence:
   * the *advice* („bitte neu laden") must not be able to drift between the
   * surfaces, only the noun.
   */
  readonly changed: string;
  /** The 403 in full, see {@link ActionSubject.forbidden}. */
  readonly forbidden: string;
}

/**
 * The message a failed save produces — a stale revision, then everything
 * {@link actionErrorMessage} already knows.
 *
 * **A 409 with a revision is not a second 400**, and telling them apart is the
 * reason this function exists rather than a chain per view: „bitte neu laden"
 * and „das Dokument ist ungültig" ask for opposite reactions.
 */
export function saveErrorMessage(error: unknown, subject: SaveSubject): string {
  if (isStaleRevision(error)) {
    return `${subject.changed} zwischenzeitlich von jemand anderem geändert. Bitte neu laden – sonst gingen die Änderungen der anderen Person verloren.`;
  }
  return actionErrorMessage(error, {
    forbidden: subject.forbidden,
    failed: 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
  });
}

/** The settings of one form. */
export const FORM_SETTINGS_SUBJECT: SaveSubject = {
  changed: 'Das Formular wurde',
  forbidden:
    'Diese Rolle darf die Einstellungen dieses Formulars nicht ändern.',
};

/** The organisation's form standards. */
export const TENANT_DEFAULTS_SUBJECT: SaveSubject = {
  changed: 'Die Formular-Standards wurden',
  forbidden:
    'Diese Rolle darf die Formular-Standards dieser Organisation nicht ändern.',
};

/** The system layer below them. */
export const SYSTEM_SETTINGS_SUBJECT: SaveSubject = {
  changed: 'Die Systemeinstellungen wurden',
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
};

/** „⧉ Duplizieren" on the dashboard card. */
export const FORM_DUPLICATE_SUBJECT: ActionSubject = {
  forbidden: 'Diese Rolle darf Formulare nicht duplizieren.',
  failed: 'Das Duplizieren ist fehlgeschlagen. Bitte erneut versuchen.',
  missing:
    'Dieses Formular ist inzwischen verschwunden — vermutlich hat es jemand anderes gelöscht.',
};

/** Restoring a form out of the trash. */
export const TRASH_RESTORE_FORM_SUBJECT: ActionSubject = {
  forbidden: 'Diese Rolle darf gelöschte Formulare nicht wiederherstellen.',
  failed: 'Das Wiederherstellen ist fehlgeschlagen. Bitte erneut versuchen.',
  // A 404 here is not the „unbekannt oder fremd" of every other route — it is
  // this exact row, already read once by the list that offered the button. It
  // means somebody else acted on it first.
  missing:
    'Das Formular ist nicht mehr im Papierkorb — vermutlich hat es jemand anderes bereits wiederhergestellt oder es ist inzwischen endgültig gelöscht.',
};

/**
 * Restoring an answer out of the trash — or the server's own refusal
 * naming why (the requirement: the Antwortlimit or a Veranstaltung filled up
 * again while the answer was away). `conflict` is only the fallback for a 409
 * whose body could not be read; the server's sentence (`error.detail`) wins
 * whenever it is there, exactly as {@link actionErrorMessage} decides for
 * every 409 in this application.
 */
export const TRASH_RESTORE_RESPONSE_SUBJECT: ActionSubject = {
  forbidden: 'Diese Rolle darf gelöschte Antworten nicht wiederherstellen.',
  failed: 'Das Wiederherstellen ist fehlgeschlagen. Bitte erneut versuchen.',
  conflict:
    'Das Wiederherstellen wurde abgelehnt. Bitte die Liste neu laden und erneut versuchen.',
  missing:
    'Die Antwort ist nicht mehr im Papierkorb — vermutlich hat sie jemand anderes bereits wiederhergestellt.',
};

/**
 * Moving a form **into** the trash — reversible,
 * for 30 days, by the same person, hence the `forbidden` sentence names
 * `canBuild` alone rather than the stronger pair of the two
 * *endgültig* routes below.
 */
export const TRASH_DELETE_FORM_SUBJECT: ActionSubject = {
  forbidden: 'Diese Rolle darf dieses Formular nicht in den Papierkorb legen.',
  failed:
    'Das Verschieben in den Papierkorb ist fehlgeschlagen. Bitte erneut versuchen.',
  missing:
    'Dieses Formular ist bereits verschwunden — vermutlich hat es jemand anderes bereits gelöscht.',
};

/**
 * Moving a single answer into the trash — the pair (`canBuild` **and**
 * `canViewResponses`) already, the same pair the *endgültig* routes below
 * ask for.
 */
export const TRASH_DELETE_RESPONSE_SUBJECT: ActionSubject = {
  forbidden: 'Diese Rolle darf diese Antwort nicht in den Papierkorb legen.',
  failed:
    'Das Verschieben in den Papierkorb ist fehlgeschlagen. Bitte erneut versuchen.',
  missing:
    'Diese Antwort ist bereits verschwunden — vermutlich hat sie jemand anderes bereits gelöscht.',
};

/**
 * **Several answers into the trash at once**  — the
 * action bar of the responses table.
 *
 * Same rights as the single answer above, so `forbidden` says the same thing in
 * the plural. `missing` is where the two differ, and it has work to do: the
 * route is **all or nothing**, so a 404 means the selection still holds an
 * answer somebody else has already removed *and* that nothing was deleted. A
 * sentence that only said „ist schon weg" would leave a reader believing the
 * rest went — and pressing again is exactly the right next step, which is why
 * it is spelled out.
 */
export const TRASH_DELETE_RESPONSES_SUBJECT: ActionSubject = {
  forbidden: 'Diese Rolle darf diese Antworten nicht in den Papierkorb legen.',
  failed:
    'Das Verschieben in den Papierkorb ist fehlgeschlagen. Bitte erneut versuchen.',
  missing:
    'Mindestens eine der ausgewählten Antworten gibt es nicht mehr — vermutlich hat sie jemand anderes bereits gelöscht. Es wurde nichts verschoben; bitte die Liste neu laden und erneut auswählen.',
};

/**
 * **Physical deletion of a form**  — the stronger
 * pair of Konzept no. 65, on top of the `canBuild` that already gates the row's
 * „Wiederherstellen".
 */
export const TRASH_PURGE_FORM_SUBJECT: ActionSubject = {
  forbidden:
    'Endgültiges Löschen verlangt zusätzlich das Antwortrecht („Antworten ansehen“) — nicht nur „Bearbeiten“.',
  failed: 'Das endgültige Löschen ist fehlgeschlagen. Bitte erneut versuchen.',
  missing:
    'Das Formular ist nicht mehr im Papierkorb — vermutlich hat es jemand anderes bereits endgültig gelöscht oder wiederhergestellt.',
};

/** **Physical deletion of an answer** , same pair. */
export const TRASH_PURGE_RESPONSE_SUBJECT: ActionSubject = {
  forbidden:
    'Endgültiges Löschen verlangt zusätzlich das Antwortrecht („Antworten ansehen“) — nicht nur „Bearbeiten“.',
  failed: 'Das endgültige Löschen ist fehlgeschlagen. Bitte erneut versuchen.',
  missing:
    'Die Antwort ist nicht mehr im Papierkorb — vermutlich hat sie jemand anderes bereits endgültig gelöscht oder wiederhergestellt.',
};

/** **🗑 Papierkorb leeren** , same pair as the two above. */
export const TRASH_EMPTY_SUBJECT: ActionSubject = {
  forbidden:
    'Papierkorb leeren verlangt zusätzlich das Antwortrecht („Antworten ansehen“) — nicht nur „Bearbeiten“.',
  failed:
    'Das Leeren des Papierkorbs ist fehlgeschlagen. Bitte erneut versuchen.',
};

/** Deleting an organization — superadmin, with the name typed out. */
export const TENANT_DELETE_SUBJECT: ActionSubject = {
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
  failed: 'Das Löschen ist fehlgeschlagen. Bitte erneut versuchen.',
  missing: 'Diese Organisation gibt es nicht mehr.',
};

/** Restoring a deleted organization. */
export const TENANT_RESTORE_SUBJECT: ActionSubject = {
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
  failed: 'Das Wiederherstellen ist fehlgeschlagen. Bitte erneut versuchen.',
  missing:
    'Dieser Organisation ist nicht mehr im Papierkorb — vermutlich wurde er bereits wiederhergestellt.',
};

/**
 * Field messages of a 400, keyed by the field the server named.
 *
 * The server names a settings field `values.closeAt`; the prefix says which
 * document the path belongs to and means nothing to a field that already knows.
 * Every other surface sends flat paths (`email`, `password`) and passes through
 * untouched — which is why „Person hinzufügen" needs no second version of this.
 *
 * **Two prefixes, not one** (review finding of 2026-08-19). Since a form's
 * privacy notice travels in the same `PUT` (ADR-0028 no. 4),
 * the same save carries a **second** sub-document, and its paths
 * begin with `privacyNotice.`. Without this branch they would be left lying: the
 * `LegalPageEditor` asks for its fields under the paths of the *document*
 * (`custom`, `fills.<SCHLÜSSEL>`), found nothing under `privacyNotice.custom`,
 * and the message „Bitte die markierten Felder prüfen." pointed at nothing —
 * *measured* on eight pages of text in „Eigener Text", where in addition the deadline,
 * the participant limit and the confirmation page stayed unsaved, because the `PUT`
 * is one.
 *
 * The two key spaces are disjoint today and are to stay so: a
 * setting is called `closeAt` or `maxResponses`, a placeholder
 * `ZWECK` (only `[A-Z0-9_]`, `legal.ts`), and `custom` is no
 * form setting. Stripping both prefixes **here** instead of in the
 * views is the point of this module: the mapping of server path to
 * control stands at one place and cannot drift per surface.
 *
 * **The legal texts of organisation and installation are the one case that
 * goes further** (ADR-0028 no. 9): their paths (`pages.<seite>.…`) name which
 * of several documents on the same screen was meant, so they pass through here
 * unchanged and the card narrows them itself — {@link issuesUnder} says why
 * that must not be a third entry in the list below.
 */
export function fieldIssues(error: unknown): SettingIssues {
  if (!(error instanceof ApiError) || error.fieldIssues === undefined) {
    return {};
  }

  const issues: Record<string, string> = {};
  for (const [path, message] of Object.entries(error.fieldIssues)) {
    issues[fieldIssueKey(path)] = message;
  }
  return issues;
}

/**
 * The prefixes that a save of the settings page brings along.
 *
 * **A fixed list, and it stays one — patterns do not belong here**
 * (the small decision ADR-0028 no. 9 leaves to whoever closes it).
 *
 * The legal texts of an organisation and of the installation travel under
 * `pages.<seite>.custom` and `pages.<seite>.fills.<SCHLÜSSEL>`, so this list
 * could have learned a pattern such as `pages.*.` instead of the callers
 * shortening their own prefix ({@link issuesUnder}). It must not, and the
 * reason is not taste:
 *
 * **The page name is not noise, it is the identity of the card.** Both surfaces
 * render *several* documents at once — two at the organisation, three at the
 * installation, all in one payload and all in one `PUT`. A pattern would strip
 * exactly the part that says which of them was meant: `pages.imprint.custom`
 * and `pages.privacy.custom` would both arrive as `custom`, and a finding about
 * the Impressum would be shown on the Datenschutzerklärung as well — on a card
 * nobody has touched. `values.` and `privacyNotice.` may be stripped globally
 * for the opposite reason: each names **one** sub-document, of which exactly
 * one instance stands on the screen.
 *
 * **And a seventh page costs nothing this way.** The prefix is derived in the
 * same `.map()` that renders the card, out of the key of the page
 * (`TENANT_LEGAL_PAGES`, `SYSTEM_LEGAL_PAGES`) — a new page brings its own
 * prefix along and no list has to be remembered. With a pattern the new page
 * would be matched too, which is precisely how the collision above would arrive
 * silently rather than be noticed.
 *
 * The price is named: two places know about a path now — this module for the
 * flat prefixes, the caller for the page it is currently rendering. That is
 * accepted, because the second knows something this module cannot: **which** of
 * the documents the card in hand is showing.
 */
const ISSUE_PREFIXES = ['values.', 'privacyNotice.'] as const;

/**
 * The messages of **one nested document**, keyed by the paths inside it.
 *
 * `issuesUnder(issues, 'pages.imprint.')` turns
 * `pages.imprint.fills.STRASSE` into `fills.STRASSE` — the name under which
 * `LegalPageEditor` asks for its field — and drops everything belonging to a
 * different document. The dropping is the point as much as the shortening: what
 * is left over would otherwise mark a foreign card (see {@link ISSUE_PREFIXES}).
 *
 * Takes the already mapped messages rather than the error, so that a surface
 * asks {@link fieldIssues} once and narrows per card — and so that this piece
 * stays a pure function over one map.
 */
export function issuesUnder(
  issues: SettingIssues,
  prefix: string,
): SettingIssues {
  const nested: Record<string, string> = {};
  for (const [path, message] of Object.entries(issues)) {
    if (path.startsWith(prefix)) {
      nested[path.slice(prefix.length)] = message;
    }
  }
  return nested;
}

/**
 * The server path, shortened to the name under which the control asks.
 *
 * A path that matches none of the prefixes comes back **unchanged** —
 * a flat surface (`email`, `password`) names its fields that way anyway,
 * and a path for which there is no control had better lie around unused
 * than accidentally mark a foreign one.
 */
function fieldIssueKey(path: string): string {
  for (const prefix of ISSUE_PREFIXES) {
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length);
    }
  }
  return path;
}
