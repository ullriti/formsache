import type { ReactElement } from 'react';
import type {
  FormMember,
  FormMemberList,
  GroupSummary,
} from '@formsache/shared';
import type { UseMutationResult } from '@tanstack/react-query';

import type { SaveFormMemberVariables } from '../../api/form-members';
import { useServerDraft } from '../../hooks/use-server-draft';
import type { CustomPropertyStyle } from '../../styles/custom-property-style';
import { inkOn } from '../../styles/readable-ink';
import { actionErrorMessage } from '../api-messages';
import { initials } from '../initials';
import {
  capOptions,
  draftOf,
  isRowDirty,
  type FormMemberDraft,
} from './form-member-draft';

export interface FormMemberRowProps {
  /**
   * The form this row is about — part of the draft's identity, never only
   * decoration. See the comment on `useServerDraft` below.
   */
  readonly formId: string;
  readonly member: FormMember;
  readonly groups: readonly GroupSummary[];
  readonly isSelf: boolean;
  /**
   * One mutation instance shared by every row (`FormMembersView` owns it), the
   * same shape `TenantList` uses for the tenant switcher: only one save is ever
   * in flight, and the row it belongs to is the one whose variables match.
   */
  readonly save: UseMutationResult<
    FormMemberList,
    Error,
    SaveFormMemberVariables
  >;
}

/**
 * One row of *Nutzerrechte je Formular* (handoff).
 *
 * **An administrator gets no controls at all — a label instead.**
 * `member.restrictable` comes from the server (`isRestrictable` in
 * `form-restriction.ts`) and is never re-derived from the group here: the same
 * fact decided twice is the shape that drifts, and the second place would be
 * the one drawing a switch the API refuses outright.
 * This is the one named exception to „was der Server verweigert, ist abwesend"
 * — the label is an **answer** („sieht immer alles"), not a control standing in
 * for one.
 */
export function FormMemberRow({
  formId,
  member,
  groups,
  isSelf,
  save,
}: FormMemberRowProps): ReactElement {
  /**
   * **The draft belongs to a person *on a form*, not to a person.**
   *
   * Keyed on `member.userId` alone, an unsaved edit survived a change of form:
   * the row is keyed by user id in the list, so moving from
   * `/forms/A/members` to `/forms/B/members` keeps this
   * component mounted whenever B's list is already cached — and „Speichern"
   * then wrote the entries typed for A onto B. It is the organisation-switch data loss
   * of `TenantFormDefaultsView` one level down, and `useServerDraft`'s own
   * tag is what closes it: a key that names both halves of the subject makes
   * the hook forget the draft the moment either half changes.
   */
  const { draft, setDraft, beginSave } = useServerDraft<FormMemberDraft>(
    `${formId}:${member.userId}`,
    draftOf(member),
  );

  // No `?.` here: once `isPending`/`isError` is true the mutation has left
  // `idle`, and `save.variables` is defined in every other status — the
  // library's own discriminated union, not a guess this component makes.
  const isPending = save.isPending && save.variables.userId === member.userId;
  const rowError =
    save.isError && save.variables.userId === member.userId
      ? save.error
      : undefined;

  const current = draft ?? draftOf(member);
  const dirty = isRowDirty(member, current);
  const caps = capOptions(member, groups, current.cappedGroupId);

  return (
    <li
      className={
        member.restrictable && current.accessRevoked
          ? 'form-members__row form-members__row--locked'
          : 'form-members__row'
      }
    >
      <span
        className="form-members__avatar"
        style={
          {
            '--group-color': member.group.color,
            // The initials sit on the organisation's group colour; the fixed light ink
            // this used to carry falls to 4.41:1 on the seeded editor gold.
            '--group-ink': inkOn(member.group.color),
          } as CustomPropertyStyle
        }
        aria-hidden="true"
      >
        {initials(member.name)}
      </span>

      <div className="form-members__identity">
        <span className="form-members__name">
          <span className="form-members__name-text">{member.name}</span>
          {isSelf ? <span className="form-members__you">Sie</span> : null}
        </span>
        <span className="form-members__meta">
          {member.email} · {member.group.name} (Organisation-Rolle)
        </span>
      </div>

      {!member.restrictable ? (
        <span className="form-members__always-badge">Sieht immer alles</span>
      ) : (
        <div className="form-members__controls">
          <label className="form-members__access">
            <span className="form-members__access-label">
              {current.accessRevoked ? 'Gesperrt' : 'Zugriff'}
            </span>
            <span className="form-members__switch">
              <input
                type="checkbox"
                role="switch"
                className="form-members__switch-input"
                checked={!current.accessRevoked}
                aria-label={`Zugriff für ${member.name} auf diesem Formular`}
                onChange={(event) => {
                  setDraft({
                    ...current,
                    accessRevoked: !event.target.checked,
                  });
                }}
              />
              <span className="form-members__switch-track" aria-hidden="true">
                <span className="form-members__switch-knob" />
              </span>
            </span>
          </label>

          <select
            className="form-members__role-select"
            aria-label={`Rolle für ${member.name} auf diesem Formular`}
            value={current.cappedGroupId ?? ''}
            onChange={(event) => {
              setDraft({
                ...current,
                cappedGroupId:
                  event.target.value === '' ? null : event.target.value,
              });
            }}
          >
            <option value="">Keine Einschränkung</option>
            {caps.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} (eingeschränkt)
              </option>
            ))}
          </select>

          {dirty ? (
            <button
              type="button"
              className="form-members__save"
              disabled={isPending}
              onClick={() => {
                save.mutate(
                  { userId: member.userId, write: current },
                  { onSuccess: beginSave() },
                );
              }}
            >
              {isPending ? 'Wird gespeichert…' : 'Speichern'}
            </button>
          ) : null}
        </div>
      )}

      {rowError !== undefined ? (
        <p className="form-members__row-error" role="alert">
          {actionErrorMessage(rowError, {
            forbidden:
              'Diese Rolle darf die Nutzerrechte dieses Formulars nicht ändern.',
            failed: 'Das Speichern ist fehlgeschlagen. Bitte erneut versuchen.',
          })}
        </p>
      ) : null}
    </li>
  );
}
