import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from './query-client';

import * as admin from './admin';
import * as aiForms from './ai-forms';
import * as formMembers from './form-members';
import * as formTemplates from './form-templates';
import * as forms from './forms';
import * as legal from './legal';
import * as mailLog from './mail-log';
import * as notifications from './notifications';
import * as opsStatus from './ops-status';
import * as publicForm from './public-form';
import * as responseColumns from './response-columns';
import * as responses from './responses';
import * as settings from './settings';
import * as setup from './setup';
import * as superadmins from './superadmins';
import * as tenantAdmin from './tenant-admin';
import * as trash from './trash';
import { emptyResponse, stubFetch } from '../test/fetch-mock';

/**
 * **The transport seam of all modules in `apps/web/src/api/`**
 * (a review finding, second half).
 *
 * ## What the finding was
 *
 * Of **19** modules **3** had a test (`auth`, `http`, `system-settings`). The
 * remaining 16 are each small on their own — and untested for exactly that
 * reason: each one is „just a `fetch`", and sixteen of them are the whole
 * connection between interface and server.
 *
 * ## What is measured here
 *
 * Not the behaviour of the views — that stands in their own files —, but the
 * **seam**: that every module builds the address it is meant to build, with
 * the method it is meant to use, and that an identifier travelling into an
 * address gets **encoded** on the way.
 *
 * The last line is the reason why this file is more than bookkeeping: an
 * identifier with a `/` or a `?` in it otherwise builds a completely different
 * request, and the repository's rule on that is unambiguous — encoding happens
 * where the address comes into being, not where the value happens to be
 * trustworthy (`auth.ts`, `oidcStartUrl`).
 *
 * ## Why one table and not sixteen files
 *
 * Sixteen files with two lines each would be sixteen places at which the next
 * route gets forgotten. The table below stands next to the watchman that keeps
 * it complete: {@link EXERCISED_MODULES} is counted against the directory.
 */

/** The hook, the expected address and the expected method. */
interface Seam {
  readonly what: string;
  /** The module's read hook, the way a view calls it. */
  readonly use: () => unknown;
  readonly path: string;
  readonly method?: string;
}

/**
 * A fresh query client per case — a shared cache would let the second case
 * read the first one's answer and never make a request at all.
 */
function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: createQueryClient() },
    children,
  );
}

/** An identifier that raw in an address would build a different request. */
const NASTY_ID = 'a/b?c=1';
const NASTY_ENCODED = encodeURIComponent(NASTY_ID);

const SEAMS: readonly Seam[] = [
  {
    what: 'admin.useTenantOverview',
    use: () => admin.useTenantOverview(),
    path: '/api/admin/tenants',
  },
  {
    what: 'admin.useDeletedTenants',
    use: () => admin.useDeletedTenants(),
    path: '/api/admin/tenants/deleted',
  },
  {
    what: 'ai-forms.useAiQuota',
    use: () => aiForms.useAiQuota(true),
    path: '/api/ai/quota',
  },
  {
    what: 'form-members.useFormMembers',
    use: () => formMembers.useFormMembers(NASTY_ID),
    path: `/api/forms/${NASTY_ENCODED}/members`,
  },
  {
    what: 'form-templates.useFormTemplates',
    use: () => formTemplates.useFormTemplates(true),
    path: '/api/form-templates',
  },
  {
    what: 'forms.useForm',
    use: () => forms.useForm(NASTY_ID),
    path: `/api/forms/${NASTY_ENCODED}`,
  },
  {
    what: 'legal.useTenantLegal',
    use: () => legal.useTenantLegal(NASTY_ID),
    path: '/api/tenant/legal',
  },
  {
    /*
      The **public** retrieval of a legal-text page (ADR-0028) — the one seam
      of this module that runs without a session. The short name travels into
      the address and is therefore measured with an identifier that raw would
      build a different request.
    */
    what: 'legal.usePublicTenantLegalPage',
    use: () => legal.usePublicTenantLegalPage(NASTY_ID, 'privacy'),
    path: `/api/public/legal/tenant/${NASTY_ENCODED}/privacy`,
  },
  {
    what: 'mail-log.useMailLogDetail',
    use: () => mailLog.useMailLogDetail(NASTY_ID),
    path: `/api/mail-log/${NASTY_ENCODED}`,
  },
  {
    what: 'notifications.useNotifications',
    use: () => notifications.useNotifications(NASTY_ID),
    path: `/api/forms/${NASTY_ENCODED}/notifications`,
  },
  {
    what: 'ops-status.useOpsStatus',
    use: () => opsStatus.useOpsStatus(),
    path: '/api/admin/ops',
  },
  {
    what: 'public-form.usePublicForm',
    use: () => publicForm.usePublicForm(NASTY_ID),
    path: `/api/public/forms/${NASTY_ENCODED}`,
  },
  {
    what: 'public-form.useResponseEdit',
    use: () => publicForm.useResponseEdit(NASTY_ID),
    path: `/api/public/responses/${NASTY_ENCODED}`,
  },
  {
    what: 'response-columns.useResponseColumns',
    use: () => responseColumns.useResponseColumns(NASTY_ID),
    path: `/api/forms/${NASTY_ENCODED}/responses/columns`,
  },
  {
    what: 'responses.useResponses',
    use: () => responses.useResponses(NASTY_ID),
    path: `/api/forms/${NASTY_ENCODED}/responses`,
  },
  {
    what: 'settings.useFormSettings',
    use: () => settings.useFormSettings(NASTY_ID),
    path: `/api/forms/${NASTY_ENCODED}/settings`,
  },
  {
    what: 'settings.useTenantFormDefaults',
    use: () => settings.useTenantFormDefaults('Organisation'),
    path: '/api/tenant/form-defaults',
  },
  {
    what: 'setup.useSetupState',
    use: () => setup.useSetupState(),
    path: '/api/setup',
  },
  {
    // The list of those who carry the system administration (ADR-0029). No
    // identifier in the address — the appointment names an address, the
    // withdrawal an identifier, and its encoding is measured by
    // `SystemSuperadminsTab.test.tsx` at the request the button triggers.
    what: 'superadmins.useSuperadmins',
    use: () => superadmins.useSuperadmins(),
    path: '/api/admin/superadmins',
  },
  {
    what: 'tenant-admin.useTenantBranding',
    use: () => tenantAdmin.useTenantBranding('Organisation'),
    path: '/api/tenant/branding',
  },
  {
    what: 'tenant-admin.useOidcConfig',
    use: () => tenantAdmin.useOidcConfig('Organisation'),
    path: '/api/tenant/oidc',
  },
  {
    what: 'tenant-admin.useTenantSmtp',
    use: () => tenantAdmin.useTenantSmtp('Organisation'),
    path: '/api/tenant/smtp',
  },
  {
    what: 'trash.useTrash',
    use: () => trash.useTrash(),
    path: '/api/trash',
  },
];

/**
 * The modules this file touches — held against the directory.
 *
 * Without this list „all modules" would be a claim: a new module would be
 * added, and nobody would notice that it stays unmeasured.
 */
const EXERCISED_MODULES: readonly string[] = [
  'admin',
  'ai-forms',
  'auth', // own file: `auth.test.ts`
  'form-members',
  'form-templates',
  'forms',
  'http', // own file: `http.test.ts`
  'legal',
  'mail-log',
  'notifications',
  'ops-status',
  'public-form',
  'query-client', // no transport: the factory of the query client
  'response-columns',
  'responses',
  'session', // hooks via `auth.ts`, measured there
  'settings',
  'setup',
  'superadmins',
  // Only mail and AI hooks left; their seams are measured by
  // `SystemMailSettingsTab.test.tsx` and `SystemAiSettingsTab.test.tsx`.
  'system-settings',
  'tenant-admin',
  'trash',
];

describe('die Transportnaht jedes API-Moduls', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const seam of SEAMS) {
    it(`${seam.what} ruft ${seam.path}`, async () => {
      // The answer is deliberately an error: what is measured is the
      // **request**, and an invented success body would have to hit the schema
      // per module — exactly the duplication this file stands against.
      const fetchMock = stubFetch().mockResolvedValue(emptyResponse(500));

      /*
        **Unmounting happens explicitly.** Without `unmount()` the previous
        case's hook stays mounted, its query client retries — and the *first*
        request to the fresh double is then the neighbour's. Measured: all
        nineteen cases reported `/api/admin/tenants`, the address of the first
        one. A case that measures the neighbour is green when the neighbour is
        right.
      */
      const { unmount } = renderHook(() => seam.use(), { wrapper });
      try {
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalled();
        });

        const [input, init] = fetchMock.mock.calls[0] ?? [];
        // `RequestInfo` is a union; this application always passes a string
        // (`http.ts`), and that stands here as an assertion instead of an
        // assumption.
        expect(typeof input).toBe('string');
        expect(input).toBe(seam.path);
        expect((init?.method ?? 'GET').toUpperCase()).toBe(
          seam.method ?? 'GET',
        );
      } finally {
        unmount();
      }
    });
  }

  it('fasst jedes Modul in `apps/web/src/api/` an', async () => {
    const { readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const modules = readdirSync(resolve(process.cwd(), 'src', 'api'))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .map((name) => name.replace(/\.ts$/u, ''))
      .sort();

    expect(modules).toStrictEqual([...EXERCISED_MODULES].sort());
  });
});
