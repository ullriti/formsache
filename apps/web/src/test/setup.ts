import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { installMatchMedia, resetViewport } from './match-media';

installMatchMedia();

beforeEach(() => {
  resetViewport();
});

afterEach(() => {
  cleanup();
});
