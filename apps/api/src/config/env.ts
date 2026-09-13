import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseApiEnv, type ApiEnv } from '@formsache/shared';

import { decodeSecretBoxKey } from '../common/secret-box/secret-box-key';

/** DI token for the validated environment (a symbol, so it cannot collide). */
export const API_ENV = Symbol('API_ENV');

/**
 * Locates the nearest `.env`, walking upwards. In this monorepo the file lives
 * at the workspace root, but the API is started both from there
 * (`node apps/api/dist/main.js`) and from its own folder (`pnpm dev`).
 *
 * Returns `undefined` when there is no `.env` — that is the normal case in
 * production, where the host supplies the environment directly.
 */
export function findEnvFile(start: string = process.cwd()): string | undefined {
  let directory = start;
  for (;;) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/**
 * Applies a `.env` file to `process.env`. Variables that are already set win:
 * `.env` is a local convenience and must never override what a host, CI runner
 * or container hands in.
 */
export function loadEnvFile(file: string | undefined = findEnvFile()): void {
  if (file === undefined) {
    return;
  }
  process.loadEnvFile(file);
}

/**
 * Reads and validates the environment against the shared Zod schema. Invalid
 * configuration fails loudly at startup instead of surfacing later as a
 * confusing runtime error.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const env = parseApiEnv(source);
  // The shared schema can only see that `SECRET_BOX_KEY` is *there*; whether
  // it decodes to 32 usable bytes is a question for the cipher, and
  // `packages/shared` is browser-bound and has no `Buffer`. Asking it here
  // keeps the promise the whole variable exists for: a deployment with a
  // mistyped key stops at `main.ts`, before anything is written, rather than
  // at the first form that switches on password protection.
  // The result is discarded — `SecretBoxModule` decodes it again for injection
  // — because it costs nothing and this call is about the *moment*, not the
  // value.
  decodeSecretBoxKey(env.SECRET_BOX_KEY);
  return env;
}
