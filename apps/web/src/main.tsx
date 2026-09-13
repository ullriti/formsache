import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { createQueryClient } from './api/query-client';

import './styles/index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html is missing the #root container');
}

// One client for the application's lifetime — the cache is the point.
const queryClient = createQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
