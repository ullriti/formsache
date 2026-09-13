import { z } from 'zod';

/**
 * Ports arrive as strings from the environment; they are coerced exactly once,
 * here, so that neither app has to guess the shape of `process.env`.
 */
const portSchema = z.coerce.number().int().min(1).max(65535);

/**
 * Treats an assignment without a value as an absent variable.
 *
 * A dotenv loader turns `MAIL_WORKER_INTERVAL_MS=` into the empty string rather
 * than into nothing at all, and `scripts/dev-setup.sh` carries a line from
 * `.env.example` into a developer's `.env` verbatim. Without this, emptying a
 * documented optional variable would be a startup error instead of “take the
 * default value”.
 *
 * Only used for the optional variables. The required ones (`DATABASE_URL`,
 * `NODE_ENV`, `SECRET_BOX_KEY`) must keep failing on an empty value — there the
 * loud stop is the feature.
 */
const blankAsAbsent = (value: unknown): unknown =>
  value === '' ? undefined : value;

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/**
 * Environment contract of `apps/api`. Every variable listed here must also be
 * documented in `.env.example`.
 */
export const apiEnvSchema = z.object({
  /**
   * Operating mode. Required and without a default, for the same reason as
   * `DATABASE_URL`: this variable is not descriptive, it *decides* something
   * security-relevant. It is what {@link SESSION_COOKIE_SECURE} falls back to,
   * so the session cookie carries `Secure` by default exactly when this says
   * `production` (`usesSecureCookies`) — a production deployment that forgot
   * the variable used to start cleanly, behave normally and hand out its
   * session cookie over plain http, with nothing failing and nothing warning.
   * With the default gone, forgetting it is a startup error with a readable
   * message instead of a silent weakening.
   *
   * The development path is unaffected: `.env.example` sets it, and
   * `cp.env.example.env` is the documented first step. Vitest
   * sets `NODE_ENV=test` in its own process, so the test suites supply it
   * without any extra wiring.
   */
  NODE_ENV: nodeEnvSchema,
  API_PORT: portSchema.default(3000),
  APP_VERSION: z.string().min(1).default('0.0.0-dev'),
  /**
   * Connection string of the PostgreSQL database. Required and without a
   * default on purpose: an API that silently starts against some fallback
   * database is worse than one that refuses to start. The same
   * variable feeds the Prisma CLI through `apps/api/prisma.config.ts`, so
   * there is exactly one place to configure it.
   */
  DATABASE_URL: z.url().refine(
    (value) => {
      // `z.url()` alone is not enough: `new URL('localhost:5432')` parses, with
      // `localhost:` as the protocol. A forgotten scheme would then pass
      // validation and surface much later as an obscure driver error.
      //
      // `canParse` rather than `new URL` in a `try`: Zod 4 runs *every* check
      // on a string, including this one, even after `z.url()` has already
      // failed. A constructor call here would therefore throw a bare
      // `TypeError: Invalid URL` out of `safeParse` for any malformed value —
      // past the error message this module builds, and past every caller that
      // expects a validation result rather than an exception.
      if (!URL.canParse(value)) {
        return false;
      }
      const { protocol } = new URL(value);
      return protocol === 'postgresql:' || protocol === 'postgres:';
    },
    { message: 'must be a postgresql:// connection string' },
  ),
  /**
   * Lifetime of a login session, in hours. Drives both the `expires_at` column
   * of the session row and the `Max-Age` of the cookie, so the two can never
   * disagree — a cookie that outlives its row would send the browser back with
   * credentials the server already refuses.
   *
   * A default is safe here, unlike for `DATABASE_URL`: a wrong lifetime makes
   * people log in again, it does not open anything up. The upper bound of 720
   * hours (30 days) exists so a typo cannot mint a year-long session.
   */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  /**
   * Whether the session cookie carries `Secure` — **and therefore which name
   * it has**, because the two are one decision (`session-cookie.ts`).
   *
   * **Absent means „whatever `NODE_ENV` says": `production` → `true`,
   * everything else → `false`.** The fallback is not written down here but in
   * `usesSecureCookies()`, the one function every writer *and* every reader of
   * the cookie goes through — the test application builds its `ApiEnv` as a
   * literal and never passes this schema at all, so a default resolved here
   * would hold for the server and not for the suites. One fallback in one
   * place, or the login sets `__Host-formsache_session` while the guard looks
   * for `formsache_session` and every request after a successful login comes
   * back 401.
   *
   * ## Why this stopped being `NODE_ENV === 'production'` alone
   *
   * A review finding, and it is worth stating as the reproduction: over
   * `http://localhost` a browser **accepts** a `Secure` cookie — loopback
   * counts as a secure context — and over `http://192.168.1.10` or a bare
   * hostname it **discards** it without a word. `docker-compose.prod.yml` pins
   * `NODE_ENV: production`, so the production stack run without TLS behaved
   * exactly like that: the login answered 200, the cookie never arrived, and
   * every request afterwards was anonymous. The operator sees „die Anmeldung
   * geht nur mit localhost" and has no way to reach the decision, because it
   * was welded to a variable that means five other things as well.
   *
   * ## ⚠️ What `false` costs
   *
   * Without `Secure` the cookie also loses the `__Host-` prefix (the prefix
   * *implies* `Secure`; a browser refuses such a cookie without it). With the
   * prefix goes the only defence against cookie tossing: any neighbouring host
   * under the same parent domain — a marketing page, a compromised side
   * service — may then write `formsache_session` for that parent domain, and
   * the server cannot tell it from its own. `session-cookie.ts` carries the
   * full reasoning at the two constants.
   *
   * So: `false` is for an installation **without TLS inside one's own
   * network** and for nothing else. A publicly reachable installation that
   * sets it has given up session integrity, and no error message will mention
   * it again — which is why the API logs the resulting shape at startup.
   *
   * A change of the value **logs everybody out**: the cookie is renamed, and a
   * browser holding the old name presents a cookie the reader no longer
   * accepts. That is a correct forced logout, not a defect.
   *
   * `z.stringbool()` rather than `z.coerce.boolean()`: coercion would turn the
   * string `"false"` into `true` — a non-empty string is truthy — and the one
   * value an operator writes to switch this off would switch it on.
   * `stringbool` takes `true/false`, `1/0`, `yes/no`, `on/off` and refuses
   * everything else, so a typo is a startup error rather than a silent
   * `Secure`.
   */
  SESSION_COOKIE_SECURE: z.preprocess(blankAsAbsent, z.stringbool().optional()),
  /**
   * How many reverse-proxy hops in front of the API may be trusted to report
   * the caller's address in `X-Forwarded-For`.
   *
   * **Defaults to 0 — trust nothing.** The header is written by whoever sends
   * the request, so trusting it without knowing how many hops are in front
   * lets any caller invent an address and walk around the login rate limit
   * (`apps/api/src/auth/login-rate-limit.ts`). Zero means `req.ip` is the peer
   * of the TCP connection, which is always true and sometimes useless.
   *
   * Useless exactly when there *is* a proxy: in the standard deployment the API sits behind
   * the nginx front door of `apps/web/Dockerfile`, and then the peer is that
   * proxy for every user — one shared rate-limit bucket, a self-inflicted
   * denial of service. That deployment sets `1`, and it is only safe because
   * that nginx **replaces** `X-Forwarded-For` with the peer address instead of
   * appending to it. Express counts hops from the right, so with `1` the value
   * the trusted proxy wrote wins over anything a caller prepended.
   *
   * The upper bound of 8 is a typo guard: a number larger than the real chain
   * would start trusting entries the chain never wrote.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),
  /**
   * Symmetric key of `SecretBoxService`
   * (`apps/api/src/common/secret-box/`), which encrypts the form access word
   * before it reaches the database.
   *
   * Required and without a default, for the same reason as `DATABASE_URL` and
   * `NODE_ENV`: the only conceivable fallback would be storing the access word
   * in clear text, and that is the failure nobody notices — the application
   * comes up healthy, every test about forms passes, and the column is
   * readable to anyone holding a database dump or a backup.
   *
   * Only the *presence* is checked here. The **form** — base64 decoding to
   * exactly 32 bytes — is checked at startup by `decodeSecretBoxKey()`, which
   * lives next to the cipher that has to agree with it. It stays out of this
   * package deliberately: `packages/shared` is also consumed by the browser
   * app, and decoding needs `Buffer`.
   */
  SECRET_BOX_KEY: z.string().min(1),
  /**
   * Directory the uploaded files live in — attachments to answers and the
   * logo of an organisation (ADR-0014 no. 2).
   *
   * **Required and without a default, and the alternative was real:** the ADR
   * weighed answering `503` at the upload against refusing to start, and chose
   * the loud stop for four reasons. Two of them are worth repeating here,
   * because this is where somebody would be tempted to add a fallback:
   *
   *   1. this variable does not *describe* something, it *decides* where
   *      personal attachments are written — the same category as
   *      `DATABASE_URL`, `NODE_ENV` and `SECRET_BOX_KEY`, and the same answer;
   *   2. `503` is the silent variant. The API would come up healthy,
   *      `/api/health` would be green, forms could be built and published, and
   *      the first person to notice would be a participant who cannot attach
   *      their proof on the day registration opens. Nobody watches that path
   *      with a monitor.
   *
   * The price is carried openly: an installation that predates this change does not
   * start after the pull until its `.env` names a directory.
   * `scripts/dev-setup.sh` — the documented step after *every* pull — carries
   * the variable over and fills in a local path, and `describeEnvFailure()`
   * names both the variable and that script.
   *
   * Only the *presence* is checked here. Whether the path is absolute, exists,
   * is a directory and is writable is checked at startup by
   * `LocalFileStorage.verifyRoot()`, next to the adapter that has to agree with
   * it — the same cut `decodeSecretBoxKey()` makes, and for the same reason:
   * `packages/shared` is consumed by the browser app and has no filesystem.
   */
  FILE_STORAGE_DIR: z.string().min(1),
  // -------------------------------------------------------------------------
  // What is **not** here any more
  //
  // `SMTP_HOST/PORT/USER/PASSWORD/SECURE/FROM` and `PUBLIC_BASE_URL` were
  // variables until recently and are system settings now — rows, not environment.
  // The dividing line is **chicken-and-egg, not important/unimportant**: this
  // schema keeps what the application needs *in order to reach the settings*
  // (the database, the key that opens what is sealed in it, and the properties
  // of the process itself). Everything that is only needed *after* startup, and
  // is overridable per organisation anyway, moved into the
  // database.
  //
  // **There is deliberately no migration path, no one-off seeding and no
  // startup notice about ignored variables** (variant (b) was
  // rejected). An installation configures its mail server once, in the
  // Systemeinstellungen.
  //
  // Because a forgotten spot here makes *nothing* red — the application starts
  // and runs quietly on a default — the same change carries a guard that
  // compares this schema with `.env.example` and `docker-compose.yml` in both
  // directions (`env-contract.test.ts`).
  // -------------------------------------------------------------------------
  /**
   * How often the mail worker looks for queued rows, in milliseconds.
   * **`0` switches the scheduler off**, and the test application sets exactly
   * that: a worker that starts on its own drains queues another test is
   * counting, and the suite becomes non-deterministic in a way that looks like
   * flakiness rather than like a missing setting.
   * Tests call `runOnce()` instead.
   */
  MAIL_WORKER_INTERVAL_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(0).default(15_000),
  ),
  /**
   * How often the 90-day purge runs, in milliseconds. Daily by
   * default; `0` switches it off, for the same reason as above.
   */
  MAIL_PURGE_INTERVAL_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(0).default(86_400_000),
  ),
  /**
   * How often the purge of orphaned attachments runs, in milliseconds (ADR-0014
   * no. 15). Daily by default; `0` switches it off, for the
   * same reason as the two above.
   *
   * **Only the cadence is configurable, never the deadline.** The 24 hours
   * after which an unclaimed upload is taken are `UNCLAIMED_FILE_LIFETIME_MS`
   * in `packages/shared`, because condition 5 of the claim reads the very same
   * constant — two numbers would be two opinions about when a file expires, and
   * the gap between them is a submitted answer with an attachment that has no
   * bytes. An environment variable for the deadline would put that gap into an
   * operator's hands.
   */
  FILE_PURGE_INTERVAL_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(0).default(86_400_000),
  ),
  /**
   * How often the 30-day purge of the trash runs, in milliseconds
   * . Daily by default; `0` switches it off, for the same
   * reason as the three above.
   *
   * **Only the cadence is configurable, never the 30 days.** They are
   * `TRASH_RETENTION_DAYS` in `packages/shared`, read by this purge *and* by
   * the trash's own „nach 30 Tagen endgültig" hint, and a variable for
   * them would let an operator shorten a deletion promise the interface keeps
   * on making — the same argument `FILE_PURGE_INTERVAL_MS` makes one entry up.
   *
   * **`0` does not merely postpone anything.** A form, an answer or an organisation in
   * the trash then stays there for ever, and so does every account the
   * purge of an organisation would have taken with it. That is a
   * development switch, not a retention setting.
   */
  TRASH_PURGE_INTERVAL_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(0).default(86_400_000),
  ),
  /**
   * How often dead session rows are cleaned up, in milliseconds.
   * Daily by default; `0` switches it off, for the
   * same reason as the four above.
   *
   * **Only the cadence, never the retention period** — the seven days are
   * `SESSION_RETENTION_DAYS` in `packages/shared`. With `0` the `session` table
   * grows monotonically again, and with it personal data for which the deletion
   * concept names a retention period: a development switch, not a retention
   * setting.
   */
  SESSION_PURGE_INTERVAL_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(0).default(86_400_000),
  ),
  /**
   * Allowlist of the hosts whose OIDC discovery the server may fetch —
   * comma-separated, subdomains included.
   *
   * **Empty is the default and means “every public host”.** This
   * application is hosting-agnostic and cannot know the
   * login services of its organizations; a mandatory list would be an
   * assumption about other people's installations.
   *
   * Address literals from private, loopback and link-local ranges are
   * **always** blocked, list or no list (`oidc-issuer.ts`). What this variable
   * can do on top of that is close off DNS rebinding — the case that a check on
   * the name fundamentally does not see.
   */
  OIDC_ISSUER_ALLOWLIST: z.preprocess(
    blankAsAbsent,
    z.string().max(2_000).optional(),
  ),
  // -------------------------------------------------------------------------
  // AI form creation (ADR-0015 no. 5 with the addendum of 2026-08-11)
  //
  // ⚠️ **Provider, key, model and switch are no longer here.**
  // `AI_PROVIDER`, `AI_ANTHROPIC_API_KEY`, `AI_MISTRAL_API_KEY`, `AI_MODEL`
  // and `AI_ENABLED` have by now moved into the Systemeinstellungen
  // (`system_setting`, key sealed). The reason is the same as with
  // `SMTP_*`: a value that an organization may override does not belong
  // in a file that describes the process — and a second switching path
  // next to the environment would be two sources for the same state,
  // one of which wins invisibly.
  //
  // If an installation still carries one of the five, the application
  // **reports** that at startup and does not read it
  // (`movedAiEnvVarsStillSet`). They are therefore deliberately **no** longer
  // in this schema: a variable in the schema would be a value that somebody
  // could after all use again.
  //
  // What remains here are the **process** quantities — how long this process
  // waits and how often it cleans up. No organization overrides those.
  // -------------------------------------------------------------------------
  /**
   * Our own deadline for one generation, in milliseconds (ADR-0015 no. 6).
   *
   * **Not** the SDK client's timeout, whose default is ten minutes and scales
   * upwards with large output ceilings. The caller mints an `AbortSignal` from
   * this and hands it to the seam, so the clock and the abort stay ours
   * instead of being a library property — the same cut ADR-0014 no. 14 makes.
   *
   * The lower bound of 1000 ms is a typo guard: `0` here would abort every
   * call before it left.
   */
  AI_REQUEST_TIMEOUT_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  ),
  /**
   * How often the 30-day purge of the stored prompts runs, in milliseconds
   * (ADR-0015 no. 8). Daily by default; `0` switches it off, for
   * the same reason as the four schedulers above.
   *
   * **Only the cadence, never the 30 days** — those are a shared constant, for
   * the same reason as `TRASH_RETENTION_DAYS`: a variable would put a deletion
   * promise the interface keeps on making into an operator's hands.
   *
   * Read by `ai-prompt-purge.service.ts`; it travels all four shores here
   * because a variable added late arrives at one shore and
   * is silently missing at the other three.
   */
  AI_USAGE_PURGE_INTERVAL_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(0).default(86_400_000),
  ),
  /**
   * How often the watchdog checks the thresholds (ADR-0016 §4).
   *
   * Five minutes: the sharpest threshold is the backlog of the
   * queue (30 minutes), and a cadence that amounts to a sixth of that
   * reports it shortly after it is exceeded instead of shortly before the
   * next hour. Checking more often costs queries without making the report
   * any earlier — the *threshold* decides when an alert goes out,
   * not the cadence.
   *
   * `0` switches it off, as with every `*_INTERVAL_MS` of this application.
   * The operating status stays visible then; only nothing reports itself
   * any more.
   */
  OPS_ALERT_INTERVAL_MS: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(0).default(300_000),
  ),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Turns a failed environment parse into something an operator can act on.
 *
 * Zod's own message is a JSON dump of issues. It technically contains the
 * variable names, and it is still the wrong thing to show at three in the
 * morning: the reader has to find the `path` inside the blob, and nothing tells
 * them *where the value is supposed to come from*.
 *
 * The concrete case this comes from: `SECRET_BOX_KEY` became required,
 * `.env.example` carries it with no value on purpose (an example key
 * would be real key material in the repository), and everyone whose `.env`
 * predates that change met a `ZodError` pointing into this file. The remedy is
 * named here so the message answers the question it raises — **both** remedies
 * since the templates were split: `scripts/dev-setup.sh` syncs against
 * `.env.example`, `scripts/prod-setup.sh` against `.env.prod.example`. Naming
 * only the first would send an operator on a server to the script that appends
 * seed passwords and test-database variables to their `.env`.
 *
 * Deliberately **not** listing which value was seen: `apiEnvSchema` guards
 * secrets, and a startup error is the single most likely thing in the whole
 * application to be pasted into a chat or an issue.
 */
function describeEnvFailure(error: z.ZodError): string {
  const named = error.issues.map((issue) => {
    const variable = issue.path.map(String).join('.');
    return variable === '' ? issue.message : `${variable} — ${issue.message}`;
  });
  return [
    'The environment is incomplete or invalid:',
    ...named.map((line) => `  ${line}`),
    'Every variable is documented in .env.example (development) and ' +
      '.env.prod.example (a server). Run the matching setup script — ' +
      './scripts/dev-setup.sh or ./scripts/prod-setup.sh — to create a .env, ' +
      'carry over variables added since yours was written, and generate the ' +
      'required secrets.',
  ].join('\n');
}

/**
 * Parses raw environment data. The input is deliberately `unknown`: the server
 * never trusts foreign data, it validates it.
 */
export function parseApiEnv(source: unknown): ApiEnv {
  const parsed = apiEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(describeEnvFailure(parsed.error));
  }
  return parsed.data;
}
