import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UseMutationResult } from '@tanstack/react-query';
import type { TenantCreate, TenantOverviewRow } from '@formsache/shared';

import { CreateTenantForm } from './CreateTenantForm';

// Local alias mirrors the prop type of `CreateTenantForm` — the component
// itself does not export it.
type CreateMutation = UseMutationResult<TenantOverviewRow, Error, TenantCreate>;

/** Only the fields `CreateTenantForm` reads from the mutation result. */
function idleMutation(): CreateMutation {
  return {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  } as unknown as CreateMutation;
}

/**
 * Header-Close (×) and footer „Abbrechen" both cancel the same panel
 * (a secondary finding): they must stay distinguishable by accessible name —
 * a Playwright `getByRole` and a screen reader both rely on it.
 */
describe('CreateTenantForm — Abbrechen-Schaltflächen', () => {
  it('unterscheidet Header-Close und Footer-Abbrechen über den zugänglichen Namen', () => {
    render(
      <CreateTenantForm
        create={idleMutation()}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Each query must resolve to exactly one element — a duplicate
    // accessible name throws here (Testing Library's own strict mode).
    const closeButton = screen.getByRole('button', {
      name: 'Formular „Neue Organisation“ schließen',
    });
    const cancelButton = screen.getByRole('button', { name: 'Abbrechen' });

    expect(closeButton).not.toBe(cancelButton);
  });
});

/**
 * **„Mich selbst als ersten Administrator eintragen"** (review finding 7).
 *
 * Two questions, and the second is the load-bearing one: that the fields
 * *disappear* (rather than standing there disabled), and that the submission
 * carries `admin: null` — without an account id, because the server takes that
 * from the session.
 *
 * *Counter-check:* in the `onSubmit` of `CreateTenantForm` the branch changed to
 * `{ email: '', name: '' }` → the second case red, with exactly the
 * body the server would send back as a 400.
 */
describe('CreateTenantForm — der erste Administrator', () => {
  /**
   * **There is no password field any more** (ADR-0024).
   *
   * The case „names the minimum length on the password field" stood here; it
   * went with the field, and the counter-check to that takes its place — plus
   * the sentence that explains what happens instead. Without it the
   * person who creates an Organisation waits for a password they never
   * learn.
   */
  it('bietet kein Passwortfeld an und sagt, dass eingeladen wird', () => {
    render(
      <CreateTenantForm
        create={idleMutation()}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Passwort des ersten Admins')).toBeNull();
    expect(screen.getByText(/bekommt eine Einladung per Mail/u)).toBeDefined();
  });

  it('blendet die Felder aus und schickt „admin: null"', () => {
    const create = idleMutation();
    render(
      <CreateTenantForm
        create={create}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Kurzname'), {
      target: { value: 'SELF' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Verein SELF' },
    });
    fireEvent.click(
      screen.getByLabelText('Mich selbst als ersten Administrator eintragen'),
    );

    for (const label of [
      'E-Mail des ersten Admins',
      'Name des ersten Admins',
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }

    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation anlegen' }),
    );

    expect(create.mutate).toHaveBeenCalledWith(
      { shortName: 'SELF', name: 'Verein SELF', admin: null },
      expect.anything(),
    );
  });
});
