import type { FormMember, GroupSummary } from '@formsache/shared';

/**
 * The unsaved state of one row of *Nutzerrechte je Formular* (* handoff) — the same document shape the wire takes
 * (`formMemberWriteSchema`), so there is nothing to translate between „what the
 * fields show" and „what gets sent".
 */
export interface FormMemberDraft {
  readonly accessRevoked: boolean;
  readonly cappedGroupId: string | null;
}

/** What a row shows before anything is typed — straight from the loaded member. */
export function draftOf(member: FormMember): FormMemberDraft {
  return {
    accessRevoked: member.accessRevoked,
    cappedGroupId: member.cappedGroupId,
  };
}

/** Whether saving this row would change anything the server has. */
export function isRowDirty(
  member: FormMember,
  draft: FormMemberDraft,
): boolean {
  return (
    draft.accessRevoked !== member.accessRevoked ||
    draft.cappedGroupId !== member.cappedGroupId
  );
}

/**
 * The roles the cap selector offers for **this** person — every group ranked
 * strictly below their own, highest first, plus whatever is currently selected.
 *
 * **The rank comparison is an offer, not the rule.** „Die Deckelung muss echt
 * niedriger sein" is decided on the server (`CAP_MUST_LOWER_MESSAGE`), against
 * the membership, on every write — the same fact re-derived here would be a
 * second place it can drift, which is exactly why `restrictable` travels on the
 * payload instead (`formMemberSchema`). A selector has to produce options from
 * something, so this one narrows the list the way the server will judge it; what
 * it must never do is *hide* server state.
 *
 * Hence `selectedId`: a cap the server has stored stays in the list even when
 * this comparison would not offer it (ranks are editable in the group editor, so
 * a stored cap can stop being „below" after the fact). Dropped from the options,
 * the `<select>` would fall back to „Keine Einschränkung" and quietly *lift* a
 * restriction nobody asked to lift.
 */
export function capOptions(
  member: FormMember,
  groups: readonly GroupSummary[],
  selectedId: string | null,
): GroupSummary[] {
  return groups
    .filter(
      (group) => group.rank < member.group.rank || group.id === selectedId,
    )
    .sort((a, b) => b.rank - a.rank);
}

/** The group a member's role for this form resolves to — their cap, or their own. */
export function effectiveGroupOf(
  member: FormMember,
  groups: readonly GroupSummary[],
): GroupSummary {
  if (member.cappedGroupId === null) {
    return member.group;
  }
  return (
    groups.find((group) => group.id === member.cappedGroupId) ?? member.group
  );
}
