import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * `.env` reader for build and test **tooling** (Vite config, Playwright
 * config).
 *
 * Unlike the API's loader in `apps/api/src/config/env.ts` this one never
 * writes to `process.env`. That is the whole point: `.env` carries
 * `NODE_ENV=development`, and Vite derives the build's NODE_ENV from the
 * process environment. Leaking it produced a development React bundle of
 * 388 kB instead of 191 kB — measured, not assumed.
 */
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

let cached: NodeJS.Dict<string> | undefined;

function fromFile(): NodeJS.Dict<string> {
  if (cached === undefined) {
    try {
      cached = parseEnv(readFileSync(ENV_FILE, 'utf8'));
    } catch {
      // No `.env` — the normal case in CI and production, where the
      // environment is supplied directly.
      cached = {};
    }
  }
  return cached;
}

/** The real environment wins; `.env` only fills gaps. */
export function readEnv(name: string): string | undefined {
  return process.env[name] ?? fromFile()[name];
}

/**
 * Reads a TCP port. An unusable value is rejected loudly instead of turning
 * into a `NaN` port that fails much later with an unrelated message.
 */
export function readPort(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${name} must be a TCP port between 1 and 65535, got: ${raw}`,
    );
  }
  return port;
}

/**
 * CI systems set `CI` to all sorts of things. Only an explicit, non-empty,
 * non-negative value counts — `CI=""` and `CI=false` mean "not CI".
 */
export function readFlag(name: string): boolean {
  const raw = readEnv(name);
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}
