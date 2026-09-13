/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { readPort } from '../../tools/env-file';

// Read @formsache/shared from source in dev and test, so a change to the shared
// schemas takes effect immediately instead of after the next build (ADR-0007).
// `vite build` deliberately keeps the default conditions and therefore
// resolves the built ESM artifact — that path stays covered by the E2E run.
const SOURCE_CONDITIONS = ['development', 'module', 'browser'];

export default defineConfig(({ command }) => {
  const webPort = readPort('WEB_PORT', 5173);
  const apiPort = readPort('API_PORT', 3000);
  const fromSource = command === 'serve';

  // The session lives in an httpOnly cookie (ADR-0005). Proxying `/api` keeps
  // browser and API on the same origin, so the cookie travels without CORS
  // credentials and without `SameSite=None`. Both dev server *and* preview
  // need it: the E2E run serves the built bundle through `vite preview`, and
  // without the proxy there every request from the app would 404.
  const apiProxy = {
    '/api': {
      target: `http://127.0.0.1:${String(apiPort)}`,
      changeOrigin: false,
    },
  };

  return {
    plugins: [react()],
    /*
      **Das Jahr, in dem diese Ausgabe gebaut wurde** (Review-Runde 3 Nr. 15).

      Es steht im Urheberrechtsvermerk der Fußzeile als Ende des Zeitraums.
      Nicht `new Date()` im Browser: ein Rechner mit falsch gestellter Uhr
      ließe die Anwendung sonst eine Veröffentlichung behaupten, die es nie
      gab. Das Bauen ist der Zeitpunkt, zu dem diese Fassung wirklich
      herausgegeben wurde — die Begründung in voller Länge steht in
      `packages/shared/src/copyright.ts`.

      Gilt auch für `vitest`: die Testläufe lesen dieselbe Konfiguration, und
      ein Wert, der nur im Bau existierte, wäre in jedem Test `undefined`.
    */
    define: {
      __BUILD_YEAR__: JSON.stringify(new Date().getFullYear()),
    },
    // `host` is spelled out rather than left at Vite's default. The default is
    // the string `localhost`, and Node binds that to whatever the resolver
    // returns first — on a machine with IPv6 that is `::1`, so a client asking
    // for `http://127.0.0.1:5173` gets a refused connection. Playwright polls
    // exactly that URL (`e2e/env.ts`), and the failure it reports is
    // "Timed out waiting … from config.webServer": nothing about the address.
    // Observed on a GitHub runner, where the E2E job waited out the full
    // budget twice — a warm build, no server output, no test ever started.
    // Binding the address the tests actually ask for removes the question.
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: apiProxy,
    },
    preview: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: apiProxy,
    },
    ...(fromSource
      ? {
          resolve: { conditions: SOURCE_CONDITIONS },
          ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
        }
      : {}),
    test: {
      environment: 'jsdom',
      globals: false,
      include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
