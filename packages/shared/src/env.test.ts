import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MOVED_AI_ENV_VARS, movedAiEnvVarsStillSet } from './ai-config.ts';
import { parseApiEnv } from './env.ts';

/** The four variables without a default; every case below has to supply them. */
const DATABASE_URL = 'postgresql://user:pw@127.0.0.1:5432/db';
const NODE_ENV = 'test';
/**
 * Where uploaded files live (ADR-0014 no. 2). Required and without a default
 * — the schema only sees that it is *there*; whether the path is
 * absolute, exists and is writable is checked by `LocalFileStorage` in
 * `apps/api`, where the filesystem is.
 */
const FILE_STORAGE_DIR = '/srv/formsache/files';
/**
 * Minted per run, never written down. No key material belongs in the
 * repository — not in `.env.example`, and not in a test file either, where a
 * checked-in "example key" is exactly as copy-pasteable as a real one
 * (proof 2).
 */
const SECRET_BOX_KEY = randomBytes(32).toString('base64');
const REQUIRED = {
  DATABASE_URL,
  NODE_ENV,
  SECRET_BOX_KEY,
  FILE_STORAGE_DIR,
};

describe('parseApiEnv', () => {
  // `NODE_ENV: 'test'` rather than the former default `development`, so the
  // assertion says the value was carried through instead of merely echoing
  // whatever the schema would have filled in anyway.
  it('fills in the documented defaults around the required variables', () => {
    expect(parseApiEnv(REQUIRED)).toStrictEqual({
      NODE_ENV: 'test',
      API_PORT: 3000,
      APP_VERSION: '0.0.0-dev',
      DATABASE_URL,
      SESSION_TTL_HOURS: 12,
      TRUST_PROXY_HOPS: 0,
      SECRET_BOX_KEY,
      FILE_STORAGE_DIR,
      // All four schedulers on their documented interval — and **nothing
      // else**. `toStrictEqual` is what makes the requirement visible here: the
      // six SMTP variables and `PUBLIC_BASE_URL` are system settings,
      // so a schema that still carried one of them fails on this line rather
      // than quietly keeping a second source for the same value.
      //
      // The third one is the file purge. Only its **cadence** is here:
      // the 24-hour deadline is `UNCLAIMED_FILE_LIFETIME_MS`, shared with
      // condition 5 of the claim, and a variable for it would be a second
      // opinion about when a file expires (ADR-0014 no. 15).
      //
      // The fourth is the 30-day purge of the trash, on the same
      // footing: the cadence is a variable, `TRASH_RETENTION_DAYS` is not.
      MAIL_WORKER_INTERVAL_MS: 15_000,
      MAIL_PURGE_INTERVAL_MS: 86_400_000,
      FILE_PURGE_INTERVAL_MS: 86_400_000,
      TRASH_PURGE_INTERVAL_MS: 86_400_000,
      // The fifth: the 30-day purge of the stored AI prompts
      // (ADR-0015 no. 8). Same footing again — the cadence is a variable, the
      // 30 days are not.
      AI_USAGE_PURGE_INTERVAL_MS: 86_400_000,
      // The cadence of the operations monitoring: five minutes, one sixth of
      // the sharpest threshold.
      OPS_ALERT_INTERVAL_MS: 300_000,
      // The seventh timer: dead session rows. On the same footing as the
      // others — the cadence is a variable, the seven days are
      // `SESSION_RETENTION_DAYS`.
      SESSION_PURGE_INTERVAL_MS: 86_400_000,
      // **The AI is off, and the four absent variables are absent from the
      // result too.** `toStrictEqual` is what makes that assertion: a schema
      // that turned `AI_PROVIDER` into `''` or `null` instead of leaving it
      // out would fail here, and `resolveAiConfig` treats those the same as
      // absent only because this line keeps the shape honest.
      AI_REQUEST_TIMEOUT_MS: 60_000,
    });
  });

  /**
   * **Enforced at the earliest possible point.**
   *
   * The AI keys are the first variables of this contract that are optional
   * *without* a default value (ADR-0015 no. 9). The line above already says
   * „nothing set at all parses"; this one says why that matters — the
   * counter-case is „den Schlüssel als Pflichtvariable in
   * `env.ts` aufnehmen", and it would turn the assertion below red.
   */
  /**
   * **The shape `docker compose` actually hands in.**
   *
   * The compose block passes `${AI_PROVIDER:-}`, so an installation that has
   * not configured an AI reaches the container with **empty strings**, not
   * with absent variables — measured on the rendered output of
   * `docker compose config`. Without `blankAsAbsent` this would be a provider
   * named `''` and a start-up error on every stack that does not want an AI:
   * the third shore breaking the first, silently, in exactly the direction
   * the requirement forbids.
   */
  it('treats the empty strings of the compose block as absent', () => {
    const parsed = parseApiEnv({
      ...REQUIRED,
      AI_REQUEST_TIMEOUT_MS: '',
      AI_USAGE_PURGE_INTERVAL_MS: '',
      OPS_ALERT_INTERVAL_MS: '',
    });
    expect(parsed.AI_REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  /**
   * **`AI_ENABLED` knows exactly two words, and everything else is a refused
   * start** (ADR-0015 no. 9).
   *
   * The `.env.example` comment used to promise the opposite („nur der exakte
   * Wert `false` schaltet ab; alles andere lässt die Funktion an"). The ADR
   * calls this switch the fastest lever an operator has at three in the
   * morning; whoever typed `FALSE` under that promise got a dead application
   * and a message about an environment variable. The behaviour is the right
   * one — a silently ignored `FALSE` is a feature that keeps spending money
   * after being switched off — so the sentence was corrected and this test is
   * what keeps the two together.
   */
  /**
   * **The five AI variables are gone, and „fort" means: no key any more**.
   *
   * `AI_PROVIDER`, the two keys, `AI_MODEL` and `AI_ENABLED` used to stand in
   * this schema, and half a configuration made the start fail. With the move
   * into the system settings both are gone — and it is **gone** and not
   * `undefined`: a field that still stood in the schema would be a value
   * somebody reads again after all, and that is exactly the two sources that
   * have already been cleared away.
   *
   * The same form as with the mail server one assertion further down, and
   * checked for the same reason: `process.env` is full of variables this
   * application never reads, so the schema cannot be strict.
   */
  it('does not carry the AI configuration any more — it is a system setting', () => {
    const parsed: Record<string, unknown> = parseApiEnv({
      ...REQUIRED,
      AI_PROVIDER: 'anthropic',
      AI_ANTHROPIC_API_KEY: 'sk-test',
      AI_MISTRAL_API_KEY: 'sk-test',
      AI_MODEL: 'claude-opus-5',
      AI_ENABLED: 'false',
    });
    for (const gone of MOVED_AI_ENV_VARS) {
      expect(parsed).not.toHaveProperty(gone);
    }
  });

  /**
   * **Half a configuration no longer takes the installation down** — and that
   * is the trade the move deliberately makes.
   *
   * An aborted start was right for as long as „Anbieter setzen" was a
   * deployment. As a form field it would be the most expensive conceivable
   * reaction: a superadmin who saves the provider before the key would take the
   * application down for everybody — including those whose Jahrestagung
   * registration has nothing to do with an AI. The refusal therefore moves into
   * the display (`describeAiConfigGap`), and the start stays untouched.
   */
  it('starts even with a half AI configuration left in the environment', () => {
    expect(() =>
      parseApiEnv({ ...REQUIRED, AI_PROVIDER: 'mistral' }),
    ).not.toThrow();
  });

  /**
   * The guard without which the move would quietly leave two sources: what has
   * stayed standing in the environment is **named**.
   */
  it('names the leftovers of an installation that upgraded', () => {
    expect(
      movedAiEnvVarsStillSet({
        AI_PROVIDER: 'anthropic',
        AI_MODEL: '',
        SESSION_TTL_HOURS: '12',
      }),
    ).toEqual(['AI_PROVIDER']);
    expect(movedAiEnvVarsStillSet({})).toEqual([]);
  });

  /**
   * Enforced at the earliest possible point: the mail configuration is
   * **not** an environment contract any more. A schema that still declared the
   * six variables would let an installation keep half of its configuration in a
   * file and half in a row, and the half in the file would be the one nobody
   * changes when an organisation's mail server moves.
   */
  it('does not carry the mail server any more — it is a system setting', () => {
    const parsed: Record<string, unknown> = parseApiEnv({
      ...REQUIRED,
      SMTP_HOST: 'mail.example.org',
      SMTP_PORT: '465',
      SMTP_USER: 'demo',
      SMTP_PASSWORD: 'pw',
      SMTP_FROM: 'no-reply@example.org',
      SMTP_SECURE: 'true',
      PUBLIC_BASE_URL: 'https://formulare.example.org',
    });

    // Not „undefined": the keys are gone. `process.env` is full of variables
    // this application never reads, so the schema cannot be strict — which is
    // precisely why the guard in `env-contract.test.ts` exists, and why a
    // leftover assignment is caught there rather than here.
    for (const gone of [
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'SMTP_FROM',
      'SMTP_SECURE',
      'PUBLIC_BASE_URL',
    ]) {
      expect(parsed).not.toHaveProperty(gone);
    }
  });

  /**
   * The shape `scripts/dev-setup.sh` actually produces: a documented optional
   * variable carried over without a value, which a dotenv loader hands in as
   * the empty string. Dropping `blankAsAbsent` would turn „ich habe den Wert
   * geleert" into a refused start.
   */
  it('treats an assignment without a value as an absent variable', () => {
    const parsed = parseApiEnv({
      ...REQUIRED,
      MAIL_WORKER_INTERVAL_MS: '',
      MAIL_PURGE_INTERVAL_MS: '',
    });
    expect(parsed.MAIL_WORKER_INTERVAL_MS).toBe(15_000);
    expect(parsed.MAIL_PURGE_INTERVAL_MS).toBe(86_400_000);
  });

  /**
   * `0` is „off", so it has to be accepted; a negative interval is a typo and
   * would otherwise become a timer that fires immediately, forever.
   */
  it('accepts 0 as "scheduler off" and rejects a negative interval', () => {
    const off = parseApiEnv({
      ...REQUIRED,
      MAIL_WORKER_INTERVAL_MS: '0',
      MAIL_PURGE_INTERVAL_MS: '0',
    });
    expect(off.MAIL_WORKER_INTERVAL_MS).toBe(0);
    expect(off.MAIL_PURGE_INTERVAL_MS).toBe(0);
    expect(() =>
      parseApiEnv({ ...REQUIRED, MAIL_WORKER_INTERVAL_MS: '-1' }),
    ).toThrow();
  });

  /**
   * **`SESSION_COOKIE_SECURE` is absent unless somebody says something** — the
   * fallback to `NODE_ENV` lives in `usesSecureCookies()` in `apps/api`, and
   * that split is deliberate (the test application builds its `ApiEnv` as a
   * literal and never passes this schema, so a default resolved here would hold
   * for the server and not for the suites). What this schema owes is therefore
   * exactly this: pass a decision through, or hand on „nobody decided".
   */
  it('passes an explicit session-cookie decision through and otherwise says nothing', () => {
    expect(parseApiEnv(REQUIRED)).not.toHaveProperty('SESSION_COOKIE_SECURE');
    expect(
      parseApiEnv({ ...REQUIRED, SESSION_COOKIE_SECURE: 'false' })
        .SESSION_COOKIE_SECURE,
    ).toBe(false);
    // …including in production, where it is the one setting that matters:
    // giving up `Secure` has to be possible *against* the operating mode, or
    // an installation without TLS has no way to say so.
    expect(
      parseApiEnv({
        ...REQUIRED,
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'false',
      }).SESSION_COOKIE_SECURE,
    ).toBe(false);
    expect(
      parseApiEnv({ ...REQUIRED, SESSION_COOKIE_SECURE: 'true' })
        .SESSION_COOKIE_SECURE,
    ).toBe(true);
    // The shape `docker compose` hands in when nobody set the variable
    // (`${SESSION_COOKIE_SECURE:-}`): an empty string is „nobody decided", not
    // „false" — otherwise the dev stack would silently answer a different
    // question than the one the operator asked.
    expect(
      parseApiEnv({ ...REQUIRED, SESSION_COOKIE_SECURE: '' })
        .SESSION_COOKIE_SECURE,
    ).toBeUndefined();
  });

  /**
   * **`z.coerce.boolean()` would have made `false` mean `true`** — a non-empty
   * string is truthy — and `false` is the one value an operator ever writes
   * here. `stringbool` takes the four documented pairs and refuses the rest, so
   * a typo stops the start instead of quietly switching `Secure` back on.
   */
  it('reads the words an operator writes and refuses the ones it cannot mean', () => {
    for (const [written, meant] of [
      ['true', true],
      ['false', false],
      ['1', true],
      ['0', false],
      ['yes', true],
      ['no', false],
      ['on', true],
      ['off', false],
    ] as const) {
      expect(
        parseApiEnv({ ...REQUIRED, SESSION_COOKIE_SECURE: written })
          .SESSION_COOKIE_SECURE,
        `SESSION_COOKIE_SECURE=${written}`,
      ).toBe(meant);
    }
    for (const nonsense of ['nope', 'sicher', '2', 'true ']) {
      expect(() =>
        parseApiEnv({ ...REQUIRED, SESSION_COOKIE_SECURE: nonsense }),
      ).toThrow(/SESSION_COOKIE_SECURE/);
    }
  });

  /**
   * The default is the whole point: a configuration that forgets this variable
   * must ignore `X-Forwarded-For`, not believe it. Believing it means any
   * caller can pick their own rate-limit bucket.
   */
  it('trusts no proxy hop unless one is configured', () => {
    expect(parseApiEnv(REQUIRED).TRUST_PROXY_HOPS).toBe(0);
    expect(
      parseApiEnv({ ...REQUIRED, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS,
    ).toBe(1);
  });

  it('rejects a hop count that no deployment could have', () => {
    expect(() =>
      parseApiEnv({ ...REQUIRED, TRUST_PROXY_HOPS: '99' }),
    ).toThrow();
    expect(() =>
      parseApiEnv({ ...REQUIRED, TRUST_PROXY_HOPS: '-1' }),
    ).toThrow();
  });

  it('coerces the session lifetime, because the environment only knows strings', () => {
    expect(
      parseApiEnv({ ...REQUIRED, SESSION_TTL_HOURS: '4' }).SESSION_TTL_HOURS,
    ).toBe(4);
  });

  // A typo must not mint a session that outlives the year — the cookie's
  // Max-Age is derived from exactly this value.
  it('rejects a session lifetime beyond the documented bound', () => {
    expect(() =>
      parseApiEnv({ ...REQUIRED, SESSION_TTL_HOURS: '10000' }),
    ).toThrow();
  });

  it('rejects a session lifetime of zero rather than expiring every session at once', () => {
    expect(() =>
      parseApiEnv({ ...REQUIRED, SESSION_TTL_HOURS: '0' }),
    ).toThrow();
  });

  it('coerces the port, because the environment only knows strings', () => {
    expect(parseApiEnv({ ...REQUIRED, API_PORT: '4000' }).API_PORT).toBe(4000);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => parseApiEnv({ ...REQUIRED, API_PORT: '70000' })).toThrow();
  });

  it('rejects an unknown NODE_ENV instead of silently accepting it', () => {
    expect(() => parseApiEnv({ ...REQUIRED, NODE_ENV: 'staging' })).toThrow();
  });

  /**
   * The silent weakening this guards against, and the reason `NODE_ENV` has no
   * default: the session cookie is marked `Secure` exactly when this says
   * `production`. A deployment that forgets the variable must fail at startup,
   * not come up looking healthy while handing its cookie out over plain http.
   */
  it('refuses to start without NODE_ENV rather than assuming development', () => {
    expect(() => parseApiEnv({ DATABASE_URL })).toThrow();
    expect(() => parseApiEnv({ DATABASE_URL, NODE_ENV: '' })).toThrow();
  });

  // The dangerous default this guards against: an API that comes up against
  // some fallback database instead of refusing to start.
  it('refuses to start without a database connection', () => {
    expect(() => parseApiEnv({ NODE_ENV })).toThrow();
    expect(() => parseApiEnv({})).toThrow();
  });

  it('rejects a DATABASE_URL that is not a URL', () => {
    expect(() =>
      parseApiEnv({ ...REQUIRED, DATABASE_URL: 'invalid' }),
    ).toThrow();
  });

  /**
   * The dangerous default this guards against is the worst of the three: with
   * a fallback key, or none, the form access word would land in the database
   * in clear text and nothing would say so.
   */
  it('refuses to start without a key for the stored secrets', () => {
    expect(() => parseApiEnv({ DATABASE_URL, NODE_ENV })).toThrow();
    expect(() =>
      parseApiEnv({ DATABASE_URL, NODE_ENV, SECRET_BOX_KEY: '' }),
    ).toThrow();
  });

  /**
   * **Enforced, at the earliest point it can be
   * made:** leave the storage variable out → the API does not start, rather
   * than writing personal attachments into some temporary directory it chose
   * for itself.
   *
   * The alternative — coming up healthy and answering `503` at the upload — was
   * weighed in ADR-0014 no. 2 and rejected: the first person to notice would be
   * a participant who cannot attach their proof on the day registration
   * opens, and nobody watches that path with a monitor.
   */
  it('refuses to start without a directory for uploaded files', () => {
    expect(() =>
      parseApiEnv({ DATABASE_URL, NODE_ENV, SECRET_BOX_KEY }),
    ).toThrow();
    expect(() => parseApiEnv({ ...REQUIRED, FILE_STORAGE_DIR: '' })).toThrow();
  });

  /**
   * Refusing to start is the easy half; saying what to do about it is the half
   * that decides whether the next person loses ten minutes. Zod's own message
   * is a JSON dump of issues — it holds the names, but not where the value is
   * supposed to come from.
   */
  it('names every missing variable and where to get it', () => {
    let message = '';
    try {
      parseApiEnv({ NODE_ENV });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('SECRET_BOX_KEY');
    expect(message).toContain('.env.example');
    expect(message).toContain('dev-setup.sh');
    // **Both templates, both scripts.** If the message named only the
    // development way, it would send an operator on a server to
    // `dev-setup.sh` — and the script would add `SEED_ADMIN_PASSWORD` and the
    // test database variables to their `.env`. That is exactly what there are
    // two templates against.
    expect(message).toContain('.env.prod.example');
    expect(message).toContain('prod-setup.sh');
    // Not a JSON blob: the reader should not have to parse the error.
    expect(message).not.toContain('"code"');
  });

  /**
   * The message is the single most likely thing in the application to be
   * pasted into a chat or an issue, so it must not carry the value it
   * rejected — a mistyped key is still a key (proof 4).
   */
  it('never repeats the value it rejected', () => {
    const wrong = randomBytes(32).toString('base64');
    let message = '';
    try {
      parseApiEnv({ ...REQUIRED, DATABASE_URL: wrong });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(wrong);
  });
});
