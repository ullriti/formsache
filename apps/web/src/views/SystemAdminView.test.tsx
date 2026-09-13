import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_AI_PATH,
  SYSTEM_MAIL_PATH,
  SYSTEM_MONITORING_PATH,
  SYSTEM_PATH,
} from '../router/routes';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { SystemAdminView } from './SystemAdminView';

/**
 * System administration — **the frame**, and only it (finding 16).
 *
 * What is checked here belongs to none of the four tabs alone and is therefore
 * to be checked nowhere else: **which tabs exist**, **where they lead**,
 * **which one is marked as open** and **that the page says whom it applies
 * to**. The tabs themselves have their own files (`SuperadminView`,
 * `OpsView`, `system-settings/…`).
 */

/** Who is looking — only the tab *Superadmins* reads it, here it belongs to the frame. */
const CURRENT_USER = 'e2d0a2b8-6a2a-4c19-9f1e-2b7c5d8e9f01';

const MAIL_DOCUMENT = {
  values: {
    smtp: null,
    publicBaseUrl: null,
    replyTo: null,
    opsAlertEmail: null,
  },
  lock: 1,
};

describe('the Systemverwaltung shell', () => {
  beforeEach(() => {
    window.history.pushState(null, '', SYSTEM_MAIL_PATH);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/');
  });

  it('offers the seven places an installation is administered from', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, MAIL_DOCUMENT));
    renderWithQuery(
      <SystemAdminView
        tab="mail"
        activeTenantId={null}
        currentUserId={CURRENT_USER}
      />,
    );

    const tabs = await screen.findByRole('navigation', {
      name: 'Systemverwaltung',
    });
    expect(
      [...tabs.querySelectorAll('button')].map((button) => button.textContent),
    ).toStrictEqual([
      'Organisationen',
      'Überwachung',
      'Mailserver',
      // *Vorlagen* came with the write path of the notification templates
      // (ADR-0022, continuation 2026-08-18) — until then the column existed,
      // but nobody who could write it.
      'Vorlagen',
      'KI',
      // *Rechtstexte* came with ADR-0028 — appended and not inserted,
      // so that a bookmark or an e2e case that counts "the fifth tab"
      // stays intact.
      'Rechtstexte',
      // *Superadmins* came with ADR-0029, appended likewise: who carries the
      // system administration is a question of the installation and no
      // subsection of the organisations.
      'Superadmins',
    ]);
  });

  it('marks the open tab as the current page, and only that one', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, MAIL_DOCUMENT));
    renderWithQuery(
      <SystemAdminView
        tab="mail"
        activeTenantId={null}
        currentUserId={CURRENT_USER}
      />,
    );

    const tabs = await screen.findByRole('navigation', {
      name: 'Systemverwaltung',
    });
    const current = [...tabs.querySelectorAll('button')].filter(
      (button) => button.getAttribute('aria-current') === 'page',
    );
    expect(current.map((button) => button.textContent)).toStrictEqual([
      'Mailserver',
    ]);
  });

  /**
   * A tab is a **place**: it changes the address, so that a bookmark,
   * a link to a colleague and the back button find it again. Without
   * this test a tab bar that only switches the state of a view
   * could not be distinguished from the right one.
   */
  it('navigates to a sibling address rather than switching a local state', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, MAIL_DOCUMENT));
    renderWithQuery(
      <SystemAdminView
        tab="mail"
        activeTenantId={null}
        currentUserId={CURRENT_USER}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'KI' }));
    expect(window.location.pathname).toBe(SYSTEM_AI_PATH);

    fireEvent.click(screen.getByRole('button', { name: 'Überwachung' }));
    expect(window.location.pathname).toBe(SYSTEM_MONITORING_PATH);

    fireEvent.click(screen.getByRole('button', { name: 'Organisationen' }));
    expect(window.location.pathname).toBe(SYSTEM_PATH);
  });

  it('names the scope of the page', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, MAIL_DOCUMENT));
    renderWithQuery(
      <SystemAdminView
        tab="mail"
        activeTenantId={null}
        currentUserId={CURRENT_USER}
      />,
    );

    // The red badge: what stands here applies to the installation and not to
    // the organisation somebody is currently working in.
    await waitFor(() => {
      expect(screen.getByText('Alle Organisationen')).toBeTruthy();
    });
    expect(
      screen.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
    ).toBeTruthy();
  });
});
