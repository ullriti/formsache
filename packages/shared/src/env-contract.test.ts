import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { apiEnvSchema } from './env.ts';

/**
 * **The environment contract, held together in every direction.**
 *
 * It has four shores, and nothing but attention holds them together:
 *
 * 1. {@link apiEnvSchema} — what the application reads,
 * 2. `.env.example` **and** `.env.prod.example` — what an operator is told to
 *    write, once for a development checkout and once for a server,
 * 3. `docker-compose.yml` and `docker-compose.prod.yml` — what actually reaches
 *    a container,
 * 4. `apps/api/test/support/create-test-app.ts` — what the suites run against.
 *
 * A forgotten **fourth** shore makes `pnpm typecheck` and one test red. A
 * forgotten **second or third** makes *nothing* red: the installation comes up
 * and runs quietly on a default. That is the direction this file closes.
 *
 * **Everything below is a closed set, never a superset.** A guard with an „and
 * anything else is fine" clause goes green for the next variable somebody adds.
 * Where a set can be *derived* from a file it is derived; where it needs a
 * decision it is written out with the reason.
 */

/** Repo root — Vitest runs each workspace project from its own package root. */
const ROOT = resolve(process.cwd(), '..', '..');

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const DEV_EXAMPLE = '.env.example';
const PROD_EXAMPLE = '.env.prod.example';
const DEV_COMPOSE = 'docker-compose.yml';
const PROD_COMPOSE = 'docker-compose.prod.yml';

/**
 * The banner both templates carry, and the line this file splits them at.
 *
 * Above it stands what a container reads; below it what only the scripts and
 * tools on the machine read — backup keys, seed accounts, the Vite port. The
 * split is checked rather than trusted: a backup key that drifts up into the
 * container half is a secret handed to a process that never needs it.
 */
const SCRIPTS_BANNER = '# Nur für die Skripte';

/**
 * Every name a `.env`-style file assigns — **including the deliberately
 * commented-out ones**.
 *
 * Both templates document a handful of names as `# NAME=…` on purpose: they are
 * documented, not set. Ignoring those lines would make this guard report them
 * as undocumented and be switched off within a week. The pattern is anchored at
 * the start of the line, so prose that mentions an assignment mid-sentence is
 * not mistaken for one.
 */
function assignedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match?.[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * A template's two halves. Throws when the banner is gone — an unsplit file
 * would otherwise be measured as „everything is a container variable".
 */
function templateRegions(path: string): {
  readonly app: Set<string>;
  readonly scripts: Set<string>;
} {
  const text = read(path);
  const at = text.indexOf(SCRIPTS_BANNER);
  if (at === -1) {
    throw new Error(`${path}: der Abschnitt „${SCRIPTS_BANNER}" fehlt`);
  }
  return {
    app: assignedNames(text.slice(0, at)),
    scripts: assignedNames(text.slice(at)),
  };
}

/**
 * The keys of one service's `environment:` block.
 *
 * Hand-parsed rather than through a YAML dependency: the shape is two nesting
 * levels of a file this repository owns, and the assertions below fail loudly
 * on a parse that found nothing — a guard that silently reads an empty set is
 * the failure mode this whole file exists against.
 */
function composeEnvironmentKeys(file: string, service: string): Set<string> {
  const lines = read(file).split('\n');
  const keys = new Set<string>();
  let inService = false;
  let inEnvironment = false;

  for (const line of lines) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      inService = line.trim() === `${service}:`;
      inEnvironment = false;
      continue;
    }
    if (!inService) {
      continue;
    }
    if (/^ {4}[A-Za-z0-9_-]+:/.test(line)) {
      inEnvironment = line.trim() === 'environment:';
      continue;
    }
    if (!inEnvironment) {
      continue;
    }
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (match?.[1] !== undefined) {
      keys.add(match[1]);
    }
  }
  return keys;
}

/**
 * Every `${NAME…}` a compose file interpolates — the variables an operator can
 * actually set. A value the file pins (`NODE_ENV: production`) is not in here,
 * and that is the point: it must not stand in a template either, because
 * setting it would do nothing.
 *
 * `$$NAME` (compose's escape, used inside the healthcheck) has no brace and is
 * not matched.
 */
function interpolatedNames(file: string): Set<string> {
  const names = new Set<string>();
  for (const match of read(file).matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * The keys of the `const env: ApiEnv = { … }` literal in `create-test-app.ts` —
 * the fourth shore.
 *
 * The type annotation there already makes an extra key a compile error, so this
 * is the *second* line of defence. It is here anyway: widening that annotation
 * to `Record<string, unknown>` is a one-word change that would leave the whole
 * suite green.
 */
function testAppEnvKeys(): Set<string> {
  const text = read('apps/api/test/support/create-test-app.ts');
  const start = text.indexOf('const env: ApiEnv = {');
  const end = text.indexOf('\n  };', start);
  const keys = new Set<string>();
  if (start === -1 || end === -1) {
    return keys;
  }
  for (const line of text.slice(start, end).split('\n')) {
    const match = /^\s{4}([A-Z_][A-Z0-9_]*):/.exec(line);
    if (match?.[1] !== undefined) {
      keys.add(match[1]);
    }
  }
  return keys;
}

/**
 * Variables the schema declares that the `api` container does **not** receive
 * as an environment variable — a closed list, with its reason.
 */
const COMPOSE_EXEMPT: Readonly<Record<string, string>> = {
  /**
   * Reaches the image as a **build argument** (`build.args.APP_VERSION`,
   * consumed by `apps/api/Dockerfile`, which turns it into an `ENV`), so it is
   * baked in rather than passed at run time — `GET /api/health` reports the
   * version the image was built as, which is the only answer that cannot drift
   * from the image. Checked below rather than believed.
   */
  APP_VERSION: 'reaches the container as a build argument, not as an env var',
};

/** Which half of which template a foreign variable belongs in. */
type Region = 'app' | 'scripts';
interface Placement {
  readonly dev: Region | null;
  readonly prod: Region | null;
  readonly why: string;
}

/**
 * Names the templates document that `apps/api` never reads — each with the
 * file, the half of that file, and why.
 *
 * Written out one by one instead of as prefixes (`SEED_*`, `POSTGRES_*`): a
 * prefix would let a *new* `SEED_…` in without anybody looking at it, and „it
 * starts with SEED_" is not an argument for anything.
 */
const NOT_READ_BY_THE_API: Readonly<Record<string, Placement>> = {
  POSTGRES_USER: { dev: 'app', prod: 'app', why: 'compose, Dienst db' },
  POSTGRES_PASSWORD: { dev: 'app', prod: 'app', why: 'compose, Dienst db' },
  POSTGRES_DB: { dev: 'app', prod: 'app', why: 'compose, Dienst db' },
  // There are no host ports in production: no service publishes a port there,
  // the operator's reverse proxy comes in front of `web`. A line for it in the
  // production template would be a knob that hangs on nothing.
  POSTGRES_PORT: { dev: 'app', prod: null, why: 'compose, Host-Port von db' },
  APP_PORT: {
    dev: 'app',
    prod: null,
    why: 'compose, Host-Port des Frontdoors',
  },
  // Auf welcher Adresse der Entwicklungsstapel diesen Port veröffentlicht.
  // Compose liest das, nicht die Anwendung — und nur der Entwicklungsstapel:
  // in der Produktion veröffentlicht kein Dienst einen Port.
  APP_BIND: {
    dev: 'app',
    prod: null,
    why: 'compose, Bindeadresse des Frontdoors',
  },
  // The front door, not the API: nginx resolves the caller with it before the
  // API counts at all. A knob only in production — in development the front
  // door itself stands at the front and trusts nobody.
  TRUSTED_PROXY_CIDR: {
    dev: null,
    prod: 'app',
    why: 'apps/web/docker/default.conf.template über compose',
  },
  IMAGE_PREFIX: {
    dev: null,
    prod: 'app',
    why: 'docker-compose.prod.yml, Registry-Präfix der Images',
  },
  // Tools on the development machine, no container.
  WEB_PORT: {
    dev: 'scripts',
    prod: null,
    why: 'apps/web/vite.config.ts und e2e/env.ts',
  },
  E2E_BASE_URL: { dev: 'scripts', prod: null, why: 'e2e/env.ts' },
  CI: { dev: 'scripts', prod: null, why: 'e2e/env.ts (vom CI-System gesetzt)' },
  TEST_DATABASE_URL: {
    dev: 'scripts',
    prod: null,
    why: 'apps/api/test/database/test-database.ts',
  },
  TEST_DATABASE_STRATEGY: {
    dev: 'scripts',
    prod: null,
    why: 'apps/api/test/database/test-database.ts',
  },
  // The seed is a development tool. A default-filled administrator password
  // in the template that gets copied onto a server would be exactly the secret
  // nobody misses until somebody uses it.
  SEED_ADMIN_EMAIL: { dev: 'scripts', prod: null, why: 'prisma/seed.ts' },
  SEED_ADMIN_NAME: { dev: 'scripts', prod: null, why: 'prisma/seed.ts' },
  SEED_ADMIN_PASSWORD: { dev: 'scripts', prod: null, why: 'prisma/seed.ts' },
  SEED_MEMBER_EMAIL: { dev: 'scripts', prod: null, why: 'prisma/seed.ts' },
  SEED_MEMBER_NAME: { dev: 'scripts', prod: null, why: 'prisma/seed.ts' },
  SEED_MEMBER_PASSWORD: { dev: 'scripts', prod: null, why: 'prisma/seed.ts' },
  SEED_TENANT_ADMIN_EMAIL: {
    dev: 'scripts',
    prod: null,
    why: 'prisma/seed.ts',
  },
  SEED_TENANT_ADMIN_NAME: { dev: 'scripts', prod: null, why: 'prisma/seed.ts' },
  SEED_TENANT_ADMIN_PASSWORD: {
    dev: 'scripts',
    prod: null,
    why: 'prisma/seed.ts',
  },
  // The backup runs **beside** the application: a script on the machine,
  // started by a cron. Its key therefore does not belong in the schema — one
  // more secret in the application's process environment that it never needs.
  BACKUP_KEY: {
    dev: null,
    prod: 'scripts',
    why: 'scripts/backup.sh und scripts/restore.sh',
  },
  BACKUP_DIR: { dev: null, prod: 'scripts', why: 'scripts/backup.sh' },
  BACKUP_KEEP_DAYS: { dev: null, prod: 'scripts', why: 'scripts/backup.sh' },
};

const foreignNamesIn = (template: 'dev' | 'prod', region: Region): string[] =>
  Object.entries(NOT_READ_BY_THE_API)
    .filter(([, entry]) => entry[template] === region)
    .map(([name]) => name);

const sorted = (names: Iterable<string>): string[] => [...names].sort();

const SCHEMA_KEYS = new Set(Object.keys(apiEnvSchema.shape));
const DEV = templateRegions(DEV_EXAMPLE);
const PROD = templateRegions(PROD_EXAMPLE);
const DEV_API_ENV = composeEnvironmentKeys(DEV_COMPOSE, 'api');
const PROD_API_ENV = composeEnvironmentKeys(PROD_COMPOSE, 'api');
const PROD_INTERPOLATED = interpolatedNames(PROD_COMPOSE);
const CONTAINER_KEYS = sorted(
  [...SCHEMA_KEYS].filter((key) => !(key in COMPOSE_EXEMPT)),
);

describe('the environment contract, held together in both directions', () => {
  it('reads every shore rather than an empty set', () => {
    // Without this, a wrong path or a changed indentation would make every
    // check below pass over nothing — a guard that fails quietly is worse than
    // none.
    expect(SCHEMA_KEYS.size).toBeGreaterThan(5);
    expect(DEV.app.size).toBeGreaterThan(15);
    expect(DEV.scripts.size).toBeGreaterThan(5);
    expect(PROD.app.size).toBeGreaterThan(10);
    expect(PROD.scripts.size).toBeGreaterThan(2);
    expect(DEV_API_ENV.size).toBeGreaterThan(5);
    expect(PROD_API_ENV.size).toBeGreaterThan(5);
    expect(PROD_INTERPOLATED.size).toBeGreaterThan(10);
    expect(testAppEnvKeys().size).toBeGreaterThan(5);
    // The parses found the right blocks and not some other ones.
    expect(DEV_API_ENV.has('DATABASE_URL')).toBe(true);
    expect(PROD_API_ENV.has('DATABASE_URL')).toBe(true);
    expect(DEV.app.has('SECRET_BOX_KEY')).toBe(true);
    expect(PROD.app.has('SECRET_BOX_KEY')).toBe(true);
    expect(PROD.scripts.has('BACKUP_KEY')).toBe(true);
  });

  /**
   * **The development template, both halves at once.**
   *
   * Held as an equality per half rather than over the whole file: the file
   * alone would go green for a seed password that wandered up into the
   * container section, and that is one of the two mistakes the split exists
   * against.
   */
  it('has exactly the right names in each half of .env.example', () => {
    expect(
      sorted(DEV.app),
      'The container half of .env.example must be the variables apiEnvSchema ' +
        'reads plus the ones NOT_READ_BY_THE_API places there. A leftover ' +
        'name is configuration that looks live and is not.',
    ).toEqual(sorted([...SCHEMA_KEYS, ...foreignNamesIn('dev', 'app')]));
    expect(
      sorted(DEV.scripts),
      'The „Nur für die Skripte" half of .env.example must hold exactly the ' +
        'names no container reads.',
    ).toEqual(sorted(foreignNamesIn('dev', 'scripts')));
  });

  /**
   * **The production template, and its container half is *derived*.**
   *
   * Not a list: exactly the names `docker-compose.prod.yml` interpolates. That
   * is the whole contract in one sentence — a variable the file pins
   * (`NODE_ENV`, `API_PORT`, `DATABASE_URL`, `FILE_STORAGE_DIR`,
   * `TRUST_PROXY_HOPS`) must **not** stand in the template, because setting it
   * would do nothing at all; a variable the file interpolates must, because
   * otherwise nobody knows it exists.
   */
  it('has exactly the right names in each half of .env.prod.example', () => {
    expect(
      sorted(PROD.app),
      'The container half of .env.prod.example must be exactly what ' +
        'docker-compose.prod.yml interpolates. A name the file pins is a knob ' +
        'that turns nothing; a name it interpolates and the template omits is ' +
        'a setting nobody knows about.',
    ).toEqual(sorted(PROD_INTERPOLATED));
    expect(
      sorted(PROD.scripts),
      'The „Nur für die Skripte" half of .env.prod.example must hold exactly ' +
        'the names the host-side scripts read.',
    ).toEqual(sorted(foreignNamesIn('prod', 'scripts')));
  });

  /**
   * The other direction for the production side: every variable the
   * application reads has to arrive one way or the other — interpolated from
   * the operator's `.env`, or pinned by the file. A variable in neither is one
   * the container silently runs on its default.
   */
  it('gets every variable the API reads into the production api container', () => {
    expect(
      sorted(PROD_API_ENV),
      'The environment: block of the api service in docker-compose.prod.yml ' +
        'must match apiEnvSchema exactly, except for COMPOSE_EXEMPT.',
    ).toEqual(CONTAINER_KEYS);
    const stranded = sorted(SCHEMA_KEYS).filter(
      (key) => !PROD.app.has(key) && !PROD_API_ENV.has(key),
    );
    expect(
      stranded,
      'These variables are neither documented in .env.prod.example nor pinned ' +
        'by docker-compose.prod.yml.',
    ).toEqual([]);
  });

  it('gets every variable the API reads into the development api container', () => {
    expect(
      sorted(DEV_API_ENV),
      'The environment: block of the api service in docker-compose.yml must ' +
        'match apiEnvSchema exactly, except for COMPOSE_EXEMPT. A variable ' +
        'missing there does not fail the stack — the container starts and ' +
        'runs on the default, which is the silence this file is about.',
    ).toEqual(CONTAINER_KEYS);
  });

  /** The one exemption, checked rather than believed. */
  it('really does hand APP_VERSION to the image as a build argument', () => {
    expect(read(DEV_COMPOSE)).toContain(
      'APP_VERSION: ${APP_VERSION:-0.0.0-dev}',
    );
    expect(read('apps/api/Dockerfile')).toContain('ARG APP_VERSION');
  });

  /**
   * The fourth shore — the reproduction „aus `env.ts` entfernt, in
   * `create-test-app.ts` stehen gelassen".
   */
  it('runs the suites against exactly the variables the schema declares', () => {
    const testAppKeys = testAppEnvKeys();
    const stale = sorted(testAppKeys).filter((key) => !SCHEMA_KEYS.has(key));
    expect(
      stale,
      'create-test-app.ts sets variables apiEnvSchema no longer declares.',
    ).toEqual([]);
    // …and the other direction, **derived rather than listed**: asking the
    // schema what it refuses to start without keeps this from ageing.
    expect(
      sorted(requiredSchemaKeys()).filter((key) => !testAppKeys.has(key)),
      'apiEnvSchema requires these variables and create-test-app.ts does not ' +
        'supply them.',
    ).toEqual([]);
  });

  /**
   * A stale exemption is the same failure one door further: `COMPOSE_EXEMPT`
   * subtracts from the expected set, so an entry for a variable the schema no
   * longer declares would go on excusing whatever takes the name next.
   */
  it('keeps the compose exemption list free of names the schema dropped', () => {
    expect(
      sorted(
        Object.keys(COMPOSE_EXEMPT).filter((key) => !SCHEMA_KEYS.has(key)),
      ),
    ).toEqual([]);
  });

  /**
   * The same for the placement list: an entry for a name the schema does read,
   * or one that names no template at all, is a decision that has expired.
   */
  it('keeps the placement list free of stale entries', () => {
    expect(
      sorted(
        Object.keys(NOT_READ_BY_THE_API).filter((key) => SCHEMA_KEYS.has(key)),
      ),
      'NOT_READ_BY_THE_API names variables the schema does read.',
    ).toEqual([]);
    expect(
      sorted(
        Object.entries(NOT_READ_BY_THE_API)
          .filter(([, entry]) => entry.dev === null && entry.prod === null)
          .map(([name]) => name),
      ),
      'entries that place a name in no template at all',
    ).toEqual([]);
  });
});

/**
 * The variables {@link apiEnvSchema} refuses to start without — read out of the
 * schema by asking it to parse nothing.
 *
 * Deliberately not derived from the schema's internals (`ZodDefault`,
 * `ZodOptional`, the pipes `z.preprocess` builds): those are shapes of the
 * library, and a Zod upgrade that rearranged them would make this guard answer
 * „nothing is required" — green, and blind.
 */
function requiredSchemaKeys(): string[] {
  const parsed = apiEnvSchema.safeParse({});
  if (parsed.success) {
    return [];
  }
  return [
    ...new Set(
      parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((segment): segment is string => typeof segment === 'string'),
    ),
  ];
}

/**
 * **The production checklist, held against the schema.**
 *
 * `docs/kb/09-betrieb.md` carries two tables: A — what the application reads —
 * and B — what `docker compose` needs on the host. A stands here; B is measured
 * by `scripts/tests/compose-prod.test.sh`, because only `docker compose config`
 * can say which variable the stack really does not start without.
 *
 * Why a checklist at all when there is the schema? Because an operator does not
 * read the schema. They read a list, tick it off and go live — which is why it
 * is checked in **both** directions.
 */
const CONTRACT_DOC = 'docs/kb/09-betrieb.md';

/**
 * The rows of one of the tables — delimited by
 * `<!-- env-contract:NAME -->` … `<!-- /env-contract:NAME -->`. A mark instead
 * of a heading: a heading gets rephrased, a mark is noticed when rephrasing. If
 * the block is missing, this function throws — holding an empty set against an
 * allow-list measures nothing.
 */
function contractRows(
  marker: string,
): { readonly name: string; readonly status: string }[] {
  const text = read(CONTRACT_DOC);
  const open = `<!-- env-contract:${marker} -->`;
  const close = `<!-- /env-contract:${marker} -->`;
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${CONTRACT_DOC}: der Block ${marker} fehlt`);
  }
  const rows: { name: string; status: string }[] = [];
  for (const line of text.slice(from + open.length, to).split('\n')) {
    // `| \`NAME\` | Status | … |` — the header and separator rows carry no
    // name in backticks and fall out by themselves.
    const match = /^\|\s*`([A-Z_][A-Z0-9_]*)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      rows.push({ name: match[1], status: match[2] });
    }
  }
  if (rows.length === 0) {
    throw new Error(`${CONTRACT_DOC}: der Block ${marker} hat keine Zeilen`);
  }
  return rows;
}

describe('die Checkliste der Produktion, gegen das Schema gehalten', () => {
  const appRows = contractRows('app');

  it('liest die Tabelle und nicht ins Leere', () => {
    expect(appRows.length).toBe(SCHEMA_KEYS.size);
  });

  it('nennt jede Variable, die die Anwendung liest', () => {
    const missing = sorted(SCHEMA_KEYS).filter(
      (key) => !appRows.some((row) => row.name === key),
    );
    expect(
      missing,
      `${CONTRACT_DOC} nennt diese Variablen des Schemas nicht: ${missing.join(', ')}`,
    ).toStrictEqual([]);
  });

  it('nennt keine, die es im Schema nicht gibt', () => {
    const invented = appRows
      .map((row) => row.name)
      .filter((name) => !SCHEMA_KEYS.has(name));
    expect(
      invented,
      `${CONTRACT_DOC} nennt Variablen, die das Schema nicht kennt: ${invented.join(', ')}`,
    ).toStrictEqual([]);
  });

  /**
   * **Pflicht means Pflicht, and Vorgabe means Vorgabe.** A list that knows
   * all the names but carries the wrong half as „hat einen Vorgabewert" sends
   * an operator live without a `SECRET_BOX_KEY`.
   */
  it('trennt Pflicht und Vorgabe genau wie das Schema', () => {
    const required = new Set(requiredSchemaKeys());
    const wrong = appRows
      .filter(
        (row) => required.has(row.name) !== row.status.startsWith('Pflicht'),
      )
      .map((row) => `${row.name} steht als „${row.status}"`);
    expect(
      wrong,
      `${CONTRACT_DOC}: Pflicht/Vorgabe weicht vom Schema ab — ${wrong.join(' · ')}`,
    ).toStrictEqual([]);
  });
});
