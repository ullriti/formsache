import { useId, type ReactElement } from 'react';
import type { GroupDetail } from '@formsache/shared';

import type { CustomPropertyStyle } from '../../styles/custom-property-style';
import { PERMISSION_LABELS } from '../permission-labels';

export interface PermissionMatrixProps {
  readonly groups: readonly GroupDetail[];
}

/**
 * „Rechte im Überblick" (the handoff's `permMatrix()`) — the five permissions
 * against every group of the active Organisation, so an editor can see what a cap
 * actually takes away without opening the group editor.
 *
 * The rows are `PERMISSION_LABELS`, the same five names the group editor's
 * pills carry: this table exists to be compared with that editor, and two
 * wordings for one flag („Antworten exportieren" here, „Export" there) is a
 * comparison an editor has to make in their head.
 */
export function PermissionMatrix({
  groups,
}: PermissionMatrixProps): ReactElement {
  const headingId = useId();

  return (
    <section className="form-members__matrix">
      <div className="form-members__matrix-head" id={headingId}>
        Rechte im Überblick
      </div>
      {/*
        A horizontally scrolling box with nothing focusable inside it is a box
        only a mouse can reach: the table is `min-width: 420px`, so at 360 px
        the rightmost groups sit outside the viewport and no amount of tabbing
        brings them in. `tabIndex` puts the box itself in the tab order, which
        is what makes the arrow keys scroll it — and a tab stop needs a name
        and a role, or the screen reader announces a stop that says nothing.
        The name is the box's own visible heading rather than a second wording
        of it.
      */}
      <div
        className="form-members__matrix-scroll"
        role="region"
        aria-labelledby={headingId}
        tabIndex={0}
      >
        <table className="form-members__matrix-table">
          <thead>
            <tr>
              <th>Recht</th>
              {groups.map((group) => (
                <th
                  key={group.id}
                  style={
                    { '--group-color': group.color } as CustomPropertyStyle
                  }
                  className="form-members__matrix-role"
                >
                  {group.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_LABELS.map(({ key, label }) => (
              <tr key={key}>
                <td className="form-members__matrix-perm">{label}</td>
                {groups.map((group) => (
                  <td key={group.id} className="form-members__matrix-cell">
                    {group.permissions[key] ? (
                      <span className="form-members__matrix-yes">✓</span>
                    ) : (
                      <span className="form-members__matrix-no">–</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
