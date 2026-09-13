/**
 * An input field, read as an optional value: trimmed, and empty means
 * `null`.
 *
 * **One version, because four of them were one too many** (a review finding of the
 * Reply-To review). The same three lines stood in
 * `tenant-admin/tenant-base-url-draft.ts`, `tenant-admin/tenant-admin-draft.ts`,
 * `tenant-admin/tenant-reply-to-draft.ts` and
 * `system-settings/system-mail-draft.ts` — in a package whose own
 * comments point twice at „die Kopie, die abdriftet" (`CONTRIBUTING.md`).
 *
 * What it expresses is everywhere the same rule: an empty field is the
 * **inheritance** („keine eigene, die Vorgabe gilt"), never the empty string. The
 * empty string would be a 400 on each of these wires for a save
 * that meant „löschen" — the schemas behind them all demand at least one
 * character.
 */
export function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
