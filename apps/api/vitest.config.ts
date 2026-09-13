import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Read @formsache/shared from source instead of from dist/ — otherwise the tests
// would measure the last build, not the current code (ADR-0007). Apart from
// `development` this is Vite's default SSR list; adding `import` here would
// hand CommonJS dependencies (express and friends) their ESM entry point.
const SOURCE_CONDITIONS = ['development', 'module', 'node'];

export default defineConfig({
  // NestJS relies on `emitDecoratorMetadata` for constructor injection; esbuild
  // and Oxc cannot emit that metadata, swc can.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  // Vite 8 transforms TypeScript with Oxc by default; swc is authoritative
  // here, so the default transform is switched off.
  oxc: false,
  resolve: { conditions: SOURCE_CONDITIONS },
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: {
    environment: 'node',
    // `test/` holds integration-test infrastructure (database provider) that
    // must stay out of the production build — `tsconfig.build.json` compiles
    // `src/` only.
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    setupFiles: ['test/setup-env.ts'],
    /*
      **The budget of a `beforeAll` that really starts a database.**

      Vitest's default is 10 s, and that number is sized for the setup a unit
      test does in its own process. 137 files under `test/` call
      `acquireTestDatabase()` in `beforeAll` instead (ADR-0008): reach or start
      a PostgreSQL 17 server, copy the migrated template into a database of
      their own, connect. Alone that takes about two seconds — measured
      2026-09-13 on `test/observability/job-run.spec.ts`: 5,1 s for the whole
      file including its six cases.

      Under the full run it is not alone. In the same `pnpm -r test` that very
      file went red with „Hook timed out in 10000ms", and its `afterAll` then
      failed a second time on the `prisma` that the aborted hook had never
      assigned — one red file, 208 green ones, 2553 passing cases, and nothing
      wrong with the code under test. Repeated on its own: green in 5 s.

      Raising the budget is **not** a tolerance for a slow test. It is the
      recognition that this hook does I/O against a database server whose
      availability depends on how many other workers are asking at the same
      moment. A minute still reports a genuinely unreachable server quickly
      enough — and it is the one direction that cannot hide a defect: a hook
      that has really hung is still red, only later.
    */
    hookTimeout: 60_000,
    // The provider announces which way it obtained the database (ADR-0008).
    // Vitest's console interception buffers those lines and the default
    // reporter drops them again outside a TTY — so exactly in CI, where the
    // announcement decides whether a green run means anything, it was
    // invisible. Measured: 0 matching lines before, 10 after.
    disableConsoleIntercept: true,
  },
});
