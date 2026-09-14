import { SYSTEM_FORM_SETTINGS, omitAvailabilityKeys } from '@formsache/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TENANT_APPEARANCE_PATH,
  TENANT_AI_PATH,
  TENANT_FORM_DEFAULTS_PATH,
  TENANT_MAIL_PATH,
  TENANT_MEMBERS_PATH,
  TENANT_TEMPLATES_PATH,
} from '../router/routes';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { TenantAdminView } from './TenantAdminView';

/**
 * Tenant administration — the frame (handoff).
 *
 * These cases are about the **frame only**: that the three entries lead to
 * three real, distinct addresses rather than to a `view` variable no link can
 * ever point at (`CONTRIBUTING.md`, „echte URLs"), and that the current one is
 * marked in a way a screen reader can read.
 *
 * They are a **navigation**, not an ARIA tab widget. The entries used to carry
 * `role="tab"` without any of what that role promises — arrow-key movement,
 * `aria-controls`, one stop in the tab order for the whole set — which tells
 * assistive technology something the page does not do; `aria-current="page"` is
 * what three sibling addresses actually are. What each tab shows is the concern
 * of its own test file.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
const CURRENT_USER_EMAIL = 'person@musterstadt-stuttgart.example';

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Organisations-Verwaltung frame', () => {
  it('asks for an organisation before asking the server for anything', async () => {
    const fetchMock = stubFetch();
    renderWithQuery(
      <TenantAdminView
        currentUserId="user-1"
        currentUserEmail={CURRENT_USER_EMAIL}
        tab="form-defaults"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        'Bitte zuerst eine Organisation auswählen',
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows all seven entries, with the current one marked', () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
    renderWithQuery(
      <TenantAdminView
        tenantId={TENANT_ID}
        tenantName="Musterstadt"
        tenantShortName="MUST"
        currentUserId="user-1"
        currentUserEmail={CURRENT_USER_EMAIL}
        tab="members"
      />,
    );

    const nav = screen.getByRole('navigation', {
      name: 'Organisations-Verwaltung',
    });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((entry) => entry.textContent),
    ).toEqual([
      'Erscheinungsbild & Login',
      'Formular-Standards',
      'Nutzerrechte',
      'Mailversand',
      'KI',
      // The sixth tab (ADR-0028) — this organisation's legal texts.
      'Rechtstexte',
      // The seventh tab (ADR-0032) — this organisation's own notification
      // templates, moved here from the system administration.
      'Vorlagen',
    ]);
    expect(
      within(nav)
        .getByRole('button', { name: 'Nutzerrechte' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(nav)
        .getByRole('button', { name: 'Erscheinungsbild & Login' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('navigates to the seven real addresses, one per tab', () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
    renderWithQuery(
      <TenantAdminView
        tenantId={TENANT_ID}
        tenantName="Musterstadt"
        tenantShortName="MUST"
        currentUserId="user-1"
        currentUserEmail={CURRENT_USER_EMAIL}
        tab="form-defaults"
      />,
    );

    const nav = screen.getByRole('navigation', {
      name: 'Organisations-Verwaltung',
    });

    fireEvent.click(
      within(nav).getByRole('button', { name: 'Erscheinungsbild & Login' }),
    );
    expect(window.location.pathname).toBe(TENANT_APPEARANCE_PATH);

    fireEvent.click(within(nav).getByRole('button', { name: 'Nutzerrechte' }));
    expect(window.location.pathname).toBe(TENANT_MEMBERS_PATH);

    fireEvent.click(within(nav).getByRole('button', { name: 'Mailversand' }));
    expect(window.location.pathname).toBe(TENANT_MAIL_PATH);

    // The fifth tab (ADR-0025) — this organisation's own AI switch,
    // the surface to a route that has existed since ADR-0015
    // and that appeared nowhere in `apps/web/src` until then.
    fireEvent.click(within(nav).getByRole('button', { name: 'KI' }));
    expect(window.location.pathname).toBe(TENANT_AI_PATH);

    fireEvent.click(
      within(nav).getByRole('button', { name: 'Formular-Standards' }),
    );
    expect(window.location.pathname).toBe(TENANT_FORM_DEFAULTS_PATH);

    // The seventh tab (ADR-0032) — this organisation's own notification
    // templates, moved here in full from the system administration.
    fireEvent.click(within(nav).getByRole('button', { name: 'Vorlagen' }));
    expect(window.location.pathname).toBe(TENANT_TEMPLATES_PATH);
  });

  it('embeds the Formular-Standards tab unchanged, without promising the other tabs a second time', async () => {
    stubFetch().mockResolvedValue(
      // One document, not four — the organisation carries a complete
      // set of values (review finding 10).
      jsonResponse(200, {
        values: omitAvailabilityKeys(SYSTEM_FORM_SETTINGS),
        revision: 1,
      }),
    );
    renderWithQuery(
      <TenantAdminView
        tenantId={TENANT_ID}
        tenantName="Musterstadt"
        tenantShortName="MUST"
        currentUserId="user-1"
        currentUserEmail={CURRENT_USER_EMAIL}
        tab="form-defaults"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Formular-Standards' }),
      ).toBeDefined();
    });
    // The tab bar itself is the frame's job; `TenantFormDefaultsView`'s own
    // suite already pins that it shows none of this when rendered alone.
    expect(
      within(
        screen.getByRole('navigation', { name: 'Organisations-Verwaltung' }),
      ).getAllByRole('button').length,
    ).toBe(7);
  });

  /**
   * **The Basis-Adresse section's own regression test, pinned here rather
   * than only in `MailIdentityCard.test.tsx`.** The task that built the
   * *Basis-Adresse* section named a real failure from this same session: a
   * whole package once answered 404 because the render branch that shows a
   * tab did not know about a section that had been built next to it.
   * `MailIdentityCard`'s own suite proves the section works; this one proves
   * the *frame* actually puts it in front of somebody who clicks
   * „Mailversand" — the render branch
   * `TenantAdminView` picks for `tab === 'mail'`.
   */
  it('shows the Basis-Adresse section inside the Mailversand tab, not only the Mailversand card', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        pathOf(input).includes('/tenant/base-url')
          ? jsonResponse(200, { baseUrl: null })
          : jsonResponse(200, { smtp: null }),
      ),
    );
    renderWithQuery(
      <TenantAdminView
        tenantId={TENANT_ID}
        tenantName="Musterstadt"
        tenantShortName="MUST"
        currentUserId="user-1"
        currentUserEmail={CURRENT_USER_EMAIL}
        tab="mail"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Mailversand' }),
      ).toBeDefined();
    });
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Basis-Adresse' }),
      ).toBeDefined();
    });
  });
});
