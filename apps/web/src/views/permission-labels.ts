import type { Permissions } from '@formsache/shared';

/**
 * The permissions of a group, in the handoff's order and with the handoff's
 * wording — **once** (design handoff: „Fünf Rechte: Bearbeiten, Antworten
 * ansehen, Export, Einstellungen, Nutzer verwalten"; the sixth,
 * *Formular-Einstellungen*, came with ADR-0021).
 *
 * Three surfaces show this list: the group editor's pills, the role legend of
 * *Nutzerrechte je Formular* and the „Rechte im Überblick"-matrix next to it.
 * They had three lists with three label sets, which is one list too many in a
 * place where the difference is invisible until two of them disagree — an
 * editor comparing the matrix with the pills would be comparing two names for
 * the same flag.
 *
 * The icon is separate from the label rather than baked into it: the pills of
 * the group editor draw it (prototype `permCols`), the matrix and the legend do
 * not, and an accessible name that carries a decorative glyph would make the
 * two surfaces impossible to query with one name.
 */
export interface PermissionLabel {
  readonly key: keyof Permissions;
  readonly label: string;
  /** Decorative, pills only (`aria-hidden` where it is drawn). */
  readonly icon: string;
}

export const PERMISSION_LABELS: readonly PermissionLabel[] = [
  { key: 'canBuild', label: 'Bearbeiten', icon: '✎' },
  { key: 'canViewResponses', label: 'Antworten ansehen', icon: '▤' },
  { key: 'canExport', label: 'Export', icon: '⭳' },
  // The two „Einstellungen" stand next to each other and are therefore
  // deliberately named differently: one applies to **one** form, the other
  // to the **organisation** (ADR-0021). Two switches both called
  // „Einstellungen" would be a permission editor in which one has to guess.
  {
    key: 'canManageFormSettings',
    label: 'Formular-Einstellungen',
    icon: '⚙',
  },
  {
    key: 'canManageSettings',
    label: 'Einstellungen der Organisation',
    icon: '⌂',
  },
  { key: 'canManageUsers', label: 'Nutzer verwalten', icon: '☷' },
];

/**
 * How many rights there are at all — the denominator of „x/y Rechte".
 *
 * Derived from {@link PERMISSION_LABELS} and not written as a number: the
 * `5` stood in two views, and a sixth right would have turned them into „6/5 Rechte"
 * without anything turning red.
 */
export const PERMISSION_TOTAL = PERMISSION_LABELS.length;

/** How many of them a group holds — the „x/y Rechte" of the handoff. */
export function permissionCount(permissions: Permissions): number {
  return PERMISSION_LABELS.filter(({ key }) => permissions[key]).length;
}

/** The held permissions as one line, for the role legend's second line. */
export function permissionSummary(permissions: Permissions): string {
  return PERMISSION_LABELS.filter(({ key }) => permissions[key])
    .map(({ label }) => label)
    .join(' · ');
}
