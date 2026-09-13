import type { ReactElement } from 'react';
import type { RenderResult } from '@testing-library/react';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { createQueryClient } from '../api/query-client';

/**
 * Renders a tree with a **fresh** query cache.
 *
 * Fresh per test on purpose: a shared client would carry one test's session
 * into the next and turn an unauthenticated case green for the wrong reason.
 */
export function renderWithQuery(ui: ReactElement): RenderResult {
  const queryClient = createQueryClient();

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}
