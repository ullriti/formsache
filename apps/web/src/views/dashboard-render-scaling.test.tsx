import type { FormSummary } from '@formsache/shared';
import { FORM_PAGE_SIZE_DEFAULT } from '@formsache/shared';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { permissions } from '../test/fixtures';
import { DashboardView } from './DashboardView';

/**
 * The countertest for the render half of `FORM_PAGE_SIZE_DEFAULT`'s rationale
 * (packages/shared/src/forms.ts, the requirement).
 *
 * That comment carries a caveat: the ≈1 ms/card figure it argues from is a
 * *single foreign measurement* out of Konzept no. 75's E2E backlog — one
 * `page.goto('/')` run with application start-up still inside it — and
 * "nothing in this repository re-measures it". This file is that
 * re-measurement, done the way this package can do it without Playwright: a
 * synchronous mount of `DashboardView` with its query cache **pre-filled**
 * (`QueryClient.setQueryData`, `staleTime: Infinity`, `refetchOnMount: false`),
 * so `performance.now()` around `render()` sees only DOM construction and
 * commit — no network mock, no loading state, nothing that timing a fetch
 * would add.
 *
 * **The counter-probe is the point, not the number.** A page size eight times
 * the default (200 rather than 24 — the Obergrenze Konzept no. 79 asks about) has
 * to take measurably longer to render, or this harness is not measuring
 * rendering at all and a "24 cards: n ms" figure from it would be worthless.
 * That is why the assertion below compares the **order** of two medians
 * rather than either against a fixed millisecond budget: the same shape
 * `test/load/anmeldestart.ts` uses for its curve, which reads p95 against
 * itself instead of a constant that would need re-tuning on every runner.
 *
 * Ten warm runs per page size, first discarded: the first mount of a page
 * size still pays for module resolution and JIT warm-up and does not belong
 * in a steady-state median.
 */

const WARM_RUNS = 10;

/** Eight times {@link FORM_PAGE_SIZE_DEFAULT} — the counter-check. */
const COUNTERPROBE_PAGE_SIZE = 200;

function formSummary(index: number): FormSummary {
  return {
    id: `019fe200-0000-7000-8000-${String(index).padStart(12, '0')}`,
    title: `Formular ${String(index)}`,
    status: index % 2 === 0 ? 'active' : 'draft',
    publishedVersion: index % 2 === 0 ? 1 : null,
    responseCount: index,
    updatedAt: '2026-07-27T10:00:00.000Z',
    permissions: permissions(),
  };
}

/**
 * One page of `count` cards, `total`/`limit` matching `count` so the pager
 * never renders (`pageCount === 1` either way) — the difference under
 * measurement is the grid alone, not an extra `<nav>` on the larger run.
 */
function page(count: number) {
  const items = Array.from({ length: count }, (_, index) => formSummary(index));
  return {
    items,
    total: count,
    activeTotal: items.filter((item) => item.status === 'active').length,
    responseTotal: items.reduce((sum, item) => sum + item.responseCount, 0),
    limit: count,
    offset: 0,
  };
}

/**
 * The exact key `useFormPage` reads (`apps/web/src/api/forms.ts`,
 * `pageQuery`): `DashboardView` always asks for `FORM_PAGE_SIZE_DEFAULT`
 * regardless of how many cards the fixture below hands back, so this stays
 * fixed across both scenarios rather than following `count`.
 */
function formsPageQueryKey(): readonly unknown[] {
  return [
    'forms',
    'page',
    { offset: 0, limit: FORM_PAGE_SIZE_DEFAULT, search: '' },
  ];
}

/**
 * One mount-measure-unmount of the grid at `count` cards.
 *
 * The `QueryClient` is primed and then frozen (`staleTime: Infinity`,
 * `refetchOnMount: false`): without that, the default `staleTime: 0` of
 * `createQueryClient()` would arm a background refetch on mount and this
 * would risk timing a mocked "request" instead of only the render.
 */
function renderGrid(count: number): number {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });
  queryClient.setQueryData(formsPageQueryKey(), page(count));

  const started = performance.now();
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />
    </QueryClientProvider>,
  );
  const elapsed = performance.now() - started;

  unmount();
  cleanup();
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

interface Spread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/** Ten warm runs, the first render of this page size discarded. */
function warmSpread(count: number): Spread {
  renderGrid(count);
  const runs = Array.from({ length: WARM_RUNS }, () => renderGrid(count));
  return {
    median: median(runs),
    min: Math.min(...runs),
    max: Math.max(...runs),
  };
}

function formatSpread(label: string, spread: Spread): string {
  return (
    `[dashboard-render-scaling] ${label}: median ${spread.median.toFixed(2)} ms, ` +
    `range ${spread.min.toFixed(2)}–${spread.max.toFixed(2)} ms ` +
    `(${String(WARM_RUNS)} warm runs)`
  );
}

describe('dashboard grid render time against page size', () => {
  it('renders the counterprobe page (200 cards) measurably slower than the default page (24 cards)', () => {
    const small = warmSpread(FORM_PAGE_SIZE_DEFAULT);
    const large = warmSpread(COUNTERPROBE_PAGE_SIZE);

    // Reported, not asserted: the absolute figures are read off *this*
    // machine and belong in the worklog/the acceptance run record next to `nproc`/RAM,
    // never compared against a constant that would go red on a slower
    // runner.
    console.info(
      formatSpread(`${String(FORM_PAGE_SIZE_DEFAULT)} cards`, small),
    );
    console.info(
      formatSpread(`${String(COUNTERPROBE_PAGE_SIZE)} cards`, large),
    );

    // The counter-check itself: if the eight-times-larger page does not come
    // out measurably slower, this harness is not measuring rendering, and
    // the 24-card figure above is worthless — which is exactly the finding
    // this test exists to surface rather than paper over with a passing
    // assertion.
    expect(large.median).toBeGreaterThan(small.median);
  }, 30_000); // not a hung test, so the budget is raised rather than the test retried. // (observed ~6.5 s here) — this is one deliberately heavier measurement, // default under normal load, but not under a busy/shared machine // 21 mounts of up to 200 cards each comfortably clear Vitest's 5 s
});
