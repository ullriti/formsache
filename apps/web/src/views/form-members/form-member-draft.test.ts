import type { FormMember, GroupSummary } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import { capOptions, effectiveGroupOf } from './form-member-draft';

/**
 * The cap selector's options (handoff).
 *
 * The rule „eine Deckelung muss echt niedriger sein" belongs to the server
 * (`CAP_MUST_LOWER_MESSAGE`); what is tested here is that the browser's *offer*
 * follows it without ever hiding what the server has stored.
 */

const ADMIN: GroupSummary = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: 'admin',
  color: '#7c0800',
  rank: 100,
  isSystem: true,
};
const EDITOR: GroupSummary = {
  id: '00000000-0000-4000-8000-0000000000c2',
  name: 'editor',
  color: '#8a6a12',
  rank: 60,
  isSystem: false,
};
const VIEWER: GroupSummary = {
  id: '00000000-0000-4000-8000-0000000000c3',
  name: 'viewer',
  color: '#5b6b52',
  rank: 20,
  isSystem: false,
};
const GROUPS = [ADMIN, EDITOR, VIEWER];

function member(overrides: Partial<FormMember> = {}): FormMember {
  return {
    userId: '00000000-0000-4000-8000-0000000000e1',
    name: 'Erik Editor',
    email: 'erik@example.org',
    group: EDITOR,
    restrictable: true,
    accessRevoked: false,
    cappedGroupId: null,
    ...overrides,
  };
}

describe('capOptions', () => {
  it('offers the roles below the person’s own, highest first', () => {
    expect(capOptions(member(), GROUPS, null).map((g) => g.name)).toEqual([
      'viewer',
    ]);
  });

  it('never offers the person’s own role or one above it', () => {
    const names = capOptions(member(), GROUPS, null).map((group) => group.name);
    expect(names).not.toContain('editor');
    expect(names).not.toContain('admin');
  });

  /**
   * Ranks are editable in the group editor, so a cap the server stored can stop
   * being „below" after the fact. Dropped from the options, the `<select>` falls
   * back to „Keine Einschränkung" and the next save silently **lifts** a
   * restriction nobody asked to lift — the client's copy of a server rule
   * overriding the server's own state.
   */
  it('keeps a stored cap in the list even when the rank order no longer offers it', () => {
    const capped = member({ cappedGroupId: ADMIN.id });

    expect(
      capOptions(capped, GROUPS, ADMIN.id).map((group) => group.id),
    ).toContain(ADMIN.id);
  });
});

describe('effectiveGroupOf', () => {
  it('is the cap where one applies, and the organisation role otherwise', () => {
    expect(effectiveGroupOf(member(), GROUPS).name).toBe('editor');
    expect(
      effectiveGroupOf(member({ cappedGroupId: VIEWER.id }), GROUPS).name,
    ).toBe('viewer');
  });
});
