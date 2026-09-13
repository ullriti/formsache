import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES } from './file-limits.ts';

/**
 * **The guard against the one limit that is written twice** (ADR-0014 no. 18).
 *
 * The application's largest file is 10 MiB. nginx' `client_max_body_size`
 * defaults to **1 MiB**, so without a line in
 * `apps/web/docker/default.conf.template` every upload above one megabyte dies
 * at the front door of the container stack — answered by nginx' own HTML page,
 * not by the readable rejection this application builds, and *before* any of
 * its tests can see it. Every suite in this repository stays green: they talk
 * to the API directly, and the front door only exists in the stack.
 *
 * So the number lives in two files, and two spellings of one number are a
 * drift waiting to happen — somebody raises `MAX_ATTACHMENT_BYTES` and nobody
 * remembers a config file in another workspace. This test reads the value out
 * of the template rather than restating it, exactly as `env-contract.test.ts`
 * reads `docker-compose.yml` and `tokens.test.ts` reads the stylesheet.
 *
 * *Reproduction (run):* removing the `client_max_body_size` line, and setting
 * it to `8m`, each turn the assertion below red.
 */

/** Repo root — Vitest runs each workspace project from its own package root. */
const ROOT = resolve(process.cwd(), '..', '..');
const TEMPLATE = 'apps/web/docker/default.conf.template';

/**
 * nginx' size suffixes. Written out rather than a lookup with a fallback: a
 * suffix this function did not know would otherwise be silently read as bytes,
 * and `12g` would pass a test that meant to check for `12m`.
 */
const UNITS: Readonly<Record<string, number>> = {
  '': 1,
  k: 1024,
  m: 1024 * 1024,
  g: 1024 * 1024 * 1024,
};

function clientMaxBodySize(directive: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(directive);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`unreadable client_max_body_size: "${directive}"`);
  }
  const unit = UNITS[match[2].toLowerCase()];
  if (unit === undefined) {
    throw new Error(`unknown size suffix in "${directive}"`);
  }
  return Number(match[1]) * unit;
}

describe('the nginx front door and the upload limit (ADR-0014 Nr. 18)', () => {
  const template = readFileSync(join(ROOT, TEMPLATE), 'utf8');

  it('sets client_max_body_size at all — the default of 1 MiB breaks every upload', () => {
    expect(
      /^\s*client_max_body_size\s+\S+;/m.test(template),
      `${TEMPLATE} sets no client_max_body_size. nginx then rejects anything ` +
        'above 1 MiB with its own error page, and no test in this repository ' +
        'notices, because they all bypass the front door.',
    ).toBe(true);
  });

  it('allows more than the largest file the application itself accepts', () => {
    const matches = [
      ...template.matchAll(/^\s*client_max_body_size\s+(\S+);/gm),
    ];
    // A guard that quietly measures nothing is the failure mode this whole
    // file exists against — so the parse has to have found something.
    expect(matches.length).toBeGreaterThan(0);

    for (const match of matches) {
      const directive = match[1];
      if (directive === undefined) {
        throw new Error('client_max_body_size matched without a value');
      }
      expect(
        clientMaxBodySize(directive),
        "The front door must clear the application's own limit, so that a " +
          'rejection comes from the application and names a reason. Raise ' +
          `client_max_body_size in ${TEMPLATE} above MAX_UPLOAD_BYTES.`,
      ).toBeGreaterThan(MAX_UPLOAD_BYTES);
    }
  });
});
