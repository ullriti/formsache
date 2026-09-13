import { randomBytes } from 'node:crypto';

import { loadEnvFile } from '../src/config/env';
import { SECRET_BOX_KEY_BYTES } from '../src/common/secret-box/secret-box-key';

/**
 * Vitest setup file: makes the repository's `.env` visible to the API tests.
 *
 * Vitest resolves `.env` relative to its own project root — here `apps/api` —
 * and would therefore miss the one file the project actually documents, at the
 * workspace root. The application loader is reused rather than reimplemented,
 * so tests and runtime read the environment by exactly the same rules,
 * including "an already set variable always wins" .
 */
loadEnvFile();

/**
 * `SECRET_BOX_KEY` is the one required variable `.env.example` cannot fill in:
 * a checked-in key would be key material in the repository, and a test key is
 * exactly as copy-pasteable as a real one (proof 2). So the
 * suites mint an ephemeral one per run.
 *
 * This is a *test* convenience and nothing more — `loadEnv()` still refuses a
 * missing or malformed key, and the tests in `src/config/env.spec.ts` prove it
 * by passing their own environment instead of `process.env`.
 */
if ((process.env.SECRET_BOX_KEY ?? '') === '') {
  process.env.SECRET_BOX_KEY =
    randomBytes(SECRET_BOX_KEY_BYTES).toString('base64');
}
