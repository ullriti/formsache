import { render, screen } from '@testing-library/react';
import type { GroupDetail } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import { PermissionMatrix } from './PermissionMatrix';

/**
 * „Rechte im Überblick" as something a keyboard can reach.
 *
 * The table is `min-width: 420px` inside a box with `overflow-x: auto`, so at
 * 360 px the rightmost groups sit outside the viewport — and the box holds no
 * focusable element of its own, which is exactly the shape axe reports as
 * `scrollable-region-focusable`: content only a mouse can get to.
 *
 * Measured through the **role and the accessible name**, not through the class
 * the fix is currently attached to. `role="region"` with a name is what makes
 * the tab stop announce something; if a later change moves the name onto a
 * `<section>` or replaces `aria-labelledby` with `aria-label`, this stays green,
 * and if it drops the name it does not.
 */

function group(overrides: Partial<GroupDetail> = {}): GroupDetail {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    name: 'admin',
    color: '#7c0800',
    rank: 100,
    isSystem: true,
    permissions: {
      canBuild: true,
      canViewResponses: true,
      canExport: true,
      canManageSettings: true,
      canManageFormSettings: true,
      canManageUsers: true,
    },
    memberCount: 2,
    ...overrides,
  };
}

describe('PermissionMatrix', () => {
  it('offers the scrolling table as a named tab stop', () => {
    render(<PermissionMatrix groups={[group()]} />);

    const region = screen.getByRole('region', { name: 'Rechte im Überblick' });

    // A tab stop, so the arrow keys can scroll the box at all. `0` and not a
    // positive value: a positive `tabindex` would jump the box ahead of every
    // control above it in the reading order.
    expect(region.getAttribute('tabindex')).toBe('0');
    // And it is the scrolling box itself that carries it, not some wrapper —
    // a name on an element that does not scroll would announce a stop the
    // arrow keys then do nothing at.
    expect(region.className).toContain('form-members__matrix-scroll');
    expect(region.contains(screen.getByRole('table'))).toBe(true);
  });

  it('takes its name from the heading a reader already sees', () => {
    render(<PermissionMatrix groups={[group()]} />);

    const region = screen.getByRole('region', { name: 'Rechte im Überblick' });
    const labelledBy = region.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();

    // Two wordings for one box is how the spoken name and the printed one
    // drift apart; the same node has to be both.
    expect(document.getElementById(String(labelledBy))?.textContent).toBe(
      'Rechte im Überblick',
    );
  });
});
