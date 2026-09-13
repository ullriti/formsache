import type { ReactElement } from 'react';
import type { FormMember, GroupDetail, GroupSummary } from '@formsache/shared';

import type { CustomPropertyStyle } from '../../styles/custom-property-style';
import { permissionSummary } from '../permission-labels';
import { effectiveGroupOf } from './form-member-draft';

export interface RoleLegendProps {
  readonly groups: readonly GroupSummary[];
  readonly members: readonly FormMember[];
  /**
   * The same groups with their permissions, for the one-line description under
   * each card. Undefined while `useTenantGroups` has not answered yet — the
   * legend still shows without it, just without the second line
   * (`api/form-members.ts`: a failure there degrades the page, it does not
   * block it).
   */
  readonly groupDetails: readonly GroupDetail[] | undefined;
}

/**
 * The role legend of the handoff's `roleLegend()` — one card per group of the
 * active Organisation, with how many people currently hold it **on this form**.
 *
 * Counted by the *effective* role (the cap if one applies, the organisation role
 * otherwise), matching the prototype's `formRoleOf`: whether access is
 * revoked does not change which role a person is counted under, only whether
 * they may use it.
 */
export function RoleLegend({
  groups,
  members,
  groupDetails,
}: RoleLegendProps): ReactElement {
  const counts = new Map<string, number>();
  for (const member of members) {
    const effective = effectiveGroupOf(member, groups);
    counts.set(effective.id, (counts.get(effective.id) ?? 0) + 1);
  }

  return (
    <div className="form-members__legend">
      {groups.map((group) => {
        const detail = groupDetails?.find((entry) => entry.id === group.id);
        const description =
          detail === undefined
            ? undefined
            : permissionSummary(detail.permissions);

        return (
          <div
            key={group.id}
            className="form-members__legend-card"
            style={{ '--group-color': group.color } as CustomPropertyStyle}
          >
            <div className="form-members__legend-head">
              <span className="form-members__legend-dot" aria-hidden="true" />
              <span className="form-members__legend-name">{group.name}</span>
              <span className="form-members__legend-count">
                {counts.get(group.id) ?? 0}
              </span>
            </div>
            {description === undefined || description === '' ? null : (
              <p className="form-members__legend-desc">{description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
