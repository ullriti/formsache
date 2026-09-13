import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Route } from '../router/routes';
import {
  formMembersPath,
  mailLogPath,
  notificationsPath,
} from '../router/routes';
import { permissions } from '../test/fixtures';
import { FormNav, formNavEntries } from './FormNav';

/**
 * The form-context navigation (Handoff, „Informationsarchitektur/Navigation";
 * the requirements put the last two entries into it).
 *
 * The rules worth pinning are about **rights**, not about pixels: every entry
 * is hidden without the permission the route behind it needs, and the
 * mail log needs *both* flags. A test that only
 * ever saw the permitted case would prove nothing (`CONTRIBUTING.md`).
 */

const FORM_ID = '019fe700-0000-7000-8000-000000000001';

/**
 * Every flag granted — and they are the **effective** ones for this form
 * (the requirement no. 3), not the organisation-wide ones off the session. The cases
 * below narrow one at a time, which is what a per-form cap does.
 */
const ALL = { formId: FORM_ID, permissions: permissions() };

/** {@link ALL} with the named flags taken away — what a cap leaves behind. */
function capped(overrides: Partial<ReturnType<typeof permissions>>) {
  return { formId: FORM_ID, permissions: permissions(overrides) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formNavEntries', () => {
  it('lists the handoff’s entries in its order', () => {
    expect(formNavEntries(ALL).map((entry) => entry.label)).toEqual([
      'Bearbeiten', // The requirement — the second half of the handoff toggle
      // „Bearbeiten / Vorschau", and therefore right beside it.
      'Vorschau',
      'Antworten',
      'Benachrichtigungen',
      'E-Mail-Versandprotokoll',
      'Formular-Einstellungen',
      'Nutzerrechte',
    ]);
  });

  it('hides the answers without can_view_responses', () => {
    const labels = formNavEntries(capped({ canViewResponses: false })).map(
      (entry) => entry.label,
    );

    expect(labels).not.toContain('Antworten');
    expect(labels).toContain('Bearbeiten');
  });

  it('hides notifications and settings without can_manage_form_settings', () => {
    const labels = formNavEntries(capped({ canManageFormSettings: false })).map(
      (entry) => entry.label,
    );

    expect(labels).not.toContain('Benachrichtigungen');
    expect(labels).not.toContain('Formular-Einstellungen');
  });

  /**
   * ADR-0021, the opposite direction — and it is the actual point of the
   * separation: taking the **organisation-wide** `can_manage_settings` away
   * must change **nothing** about this menu. Without this case „ein eigenes
   * Recht statt `can_manage_settings` auszuweiten" would only be a renaming
   * nobody verifies; the standard group `editor` is exactly this case.
   */
  it('lässt alle sechs Einträge stehen, wenn nur das organisationsweite Recht fehlt', () => {
    const labels = formNavEntries(capped({ canManageSettings: false })).map(
      (entry) => entry.label,
    );

    expect(labels).toEqual([
      'Bearbeiten',
      'Vorschau',
      'Antworten',
      'Benachrichtigungen',
      'E-Mail-Versandprotokoll',
      'Formular-Einstellungen',
      'Nutzerrechte',
    ]);
  });

  /**
   * Konzept no. 17: the mail log carries participants' addresses and subjects
   * rendered from answers, so **both** flags are required. Each half is asserted
   * on its own — „ohne beide → weg" would not show that either one alone is
   * insufficient.
   */
  it.each([
    ['ohne can_view_responses', { canViewResponses: false }],
    ['ohne can_manage_form_settings', { canManageFormSettings: false }],
  ])('hides the mail log %s', (_name, overrides) => {
    const labels = formNavEntries(capped(overrides)).map(
      (entry) => entry.label,
    );

    expect(labels).not.toContain('E-Mail-Versandprotokoll');
  });

  /**
   * Since ADR-0021 **two** rights open this entry, because two rights open
   * the route behind it: `can_manage_users` **or**
   * `can_manage_form_settings`. So it is gone only when both are missing — and
   * that is exactly what the three cases check: each one alone suffices, none
   * does not.
   */
  it('hides Nutzerrechte only when both rights are gone', () => {
    const labels = formNavEntries(
      capped({ canManageUsers: false, canManageFormSettings: false }),
    ).map((entry) => entry.label);

    expect(labels).not.toContain('Nutzerrechte');
    // …and the entry is not gone because the list would be empty.
    expect(labels).toContain('Antworten');
  });

  it.each([
    ['nur can_manage_users', { canManageFormSettings: false }],
    ['nur can_manage_form_settings', { canManageUsers: false }],
  ])('zeigt Nutzerrechte mit %s', (_name, overrides) => {
    const labels = formNavEntries(capped(overrides)).map(
      (entry) => entry.label,
    );

    expect(labels).toContain('Nutzerrechte');
  });

  /**
   * Regression: „Bearbeiten" was the one entry that read no
   * flag at all, so a role with only „Antworten ansehen" was offered the door
   * to an editor whose `PUT /api/forms/:id` answers 403.
   */
  it('hides Bearbeiten without can_build', () => {
    const labels = formNavEntries(capped({ canBuild: false })).map(
      (entry) => entry.label,
    );

    expect(labels).not.toContain('Bearbeiten');
    // …and the entries gated on the other flags stay, so this is about the
    // one flag rather than about an empty list.
    expect(labels).toContain('Antworten');
  });

  it('points every entry at the address of its route', () => {
    const byKind = new Map(
      formNavEntries(ALL).map((entry) => [entry.kind, entry.path]),
    );

    expect(byKind.get('notifications')).toBe(notificationsPath(FORM_ID));
    // With the prefilter — the log is tenant-wide, one arrives at it from a
    // form.
    expect(byKind.get('mail-log')).toBe(mailLogPath(FORM_ID));
    expect(byKind.get('form-members')).toBe(formMembersPath(FORM_ID));
  });
});

describe('FormNav', () => {
  function renderNav(route: Route) {
    return render(
      <FormNav formId={FORM_ID} route={route} permissions={permissions()} />,
    );
  }

  it('marks the open view and only that one', () => {
    renderNav({ kind: 'notifications', formId: FORM_ID });

    expect(
      screen
        .getByRole('button', { name: /Benachrichtigungen/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('button', { name: /Bearbeiten/ })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('navigates to the mail log', () => {
    renderNav({ kind: 'builder', formId: FORM_ID });

    fireEvent.click(
      screen.getByRole('button', { name: /E-Mail-Versandprotokoll/ }),
    );

    expect(window.location.pathname).toBe(mailLogPath(FORM_ID));
  });

  it('navigates to the per-form user rights', () => {
    renderNav({ kind: 'builder', formId: FORM_ID });

    fireEvent.click(screen.getByRole('button', { name: /Nutzerrechte/ }));

    expect(window.location.pathname).toBe(formMembersPath(FORM_ID));
  });

  it('is a landmark a keyboard user can reach by name', () => {
    renderNav({ kind: 'builder', formId: FORM_ID });

    expect(
      screen.getByRole('navigation', { name: 'Aktuelles Formular' }),
    ).toBeDefined();
  });
});
