import { AI_QUOTA_EXHAUSTED_MESSAGE } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, createUser } from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { RecordedFormGenerator } from '../support/recorded-form-generator';
import { RECORDED_DRAFT } from './recorded-answers';

/**
 * **The rate limit of the AI route is built, not merely decorated** (ADR-0015 no. 12).
 *
 * ## Why this file exists
 *
 * It is a **review finding** (security review, 2026-08-10).
 * ADR-0015 no. 12 prescribes `@UseGuards(ThrottlerGuard)` **and** `@Throttle`
 * next to each other, with the express reasoning: „ein Dekorator ohne
 * Guard ist vom gebauten Zustand nicht zu unterscheiden". Precisely this
 * difference was not measurable — `@UseGuards(ThrottlerGuard)` could be
 * removed from the route, and the whole AI suite stayed green, 133 assertions.
 *
 * There is no global `APP_GUARD` for the throttler in this application.
 * Every limited route carries its guard itself — and one that loses it
 * looks like one that has it: the decorator stays standing, the
 * configuration stays standing, only the limit is gone. That is the same
 * shape of error with which the limit of the login disappeared when a
 * second `ThrottlerModule.forRoot` replaced the first.
 *
 * ## And the second assurance: **two** 429s are to be told apart
 *
 * The same route answers with 429 for two entirely different reasons, and
 * the remedies are opposite: „wait a minute" against „this organisation
 * has no quota left for this month, the superadmin can raise it"
 * . The caller can tell them apart only by the text — hence
 * `AI_QUOTA_EXHAUSTED_MESSAGE` in `packages/shared`, and hence this
 * case measures that the throttle does **not** send the quota message.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 120_000;

/**
 * Seven calls against a limit of six per minute — the smallest number that
 * exceeds the limit. It stands **here** and not as an imported
 * constant: `AI_GENERATE_RATE_LIMIT` is module-private in the controller, and a
 * test that draws its expectation from the same number as the code does not
 * measure the limit, but only that both read the same variable.
 */
const LIMIT = 6;

describe('das Rate-Limit der KI-Route', () => {
  let database: TestDatabase;
  let app: TestApp;
  let session: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    app = await createTestApp({
      databaseUrl: database.url,
      // Since the move into the system settings a row, not an environment variable.
      ai: { provider: 'anthropic', apiKey: 'test-key-not-a-real-one' },
      // The recorded generator answers immediately — what is measured is the
      // throttle, not a provider.
      aiGenerator: new RecordedFormGenerator({
        ok: true,
        draft: RECORDED_DRAFT,
        usage: null,
      }),
    });

    const tenant = await createTenant(app.prisma, 'KILIMIT');
    const builder = await createUser(app.prisma, {
      email: 'bearbeiter@kilimit.example.org',
      password: 'passwort-fuer-den-test',
      tenants: [tenant],
    });
    session = await openSession(app, builder.id, tenant.id);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    await database.release();
  });

  it(
    'lässt sechs Aufrufe je Minute durch und weist den siebten ab',
    async () => {
      const statuses: number[] = [];
      const bodies: string[] = [];

      // One after the other, not simultaneously: the throttle counts
      // requests, and parallel calls could overtake each other while counting
      // up — what is measured here is the limit, not its concurrency.
      for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
        const response = await request(app.server)
          .post(apiPath('/ai/forms'))
          .set(authedMutation(session))
          .send({ prompt: `Ein Formular, Versuch ${String(attempt)}` });
        statuses.push(response.status);
        bodies.push(response.text);
      }

      // Six times 200, then 429 — asserted as a whole sequence, not just „the
      // last one was 429": a guard that takes effect too early would otherwise
      // get through.
      expect(statuses).toStrictEqual([200, 200, 200, 200, 200, 200, 429]);

      // **And it is the throttle, not the quota.** Both answer with
      // 429 on the same route; whoever cannot tell them apart can react to
      // neither of the two. The quota stands at 50,
      // seven calls do not touch it.
      expect(bodies[LIMIT]).not.toContain(AI_QUOTA_EXHAUSTED_MESSAGE);
    },
    CASE_TIMEOUT_MS,
  );
});
