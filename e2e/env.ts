import { readEnv, readFlag, readPort } from '../tools/env-file';

/**
 * Shared environment resolution for `playwright.config.ts` and the specs, so
 * both agree on ports and on what "we are in CI" means.
 *
 * Nothing is written to `process.env`: the servers Playwright starts are child
 * processes that read `.env` themselves, and a leaked `NODE_ENV=development`
 * would make the E2E run measure a development bundle.
 */
export const isCi = readFlag('CI');

export const webBaseUrl =
  readEnv('E2E_BASE_URL') ??
  `http://127.0.0.1:${String(readPort('WEB_PORT', 5173))}`;

export const apiBaseUrl = `http://127.0.0.1:${String(readPort('API_PORT', 3000))}`;
