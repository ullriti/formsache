import { ConsoleLogger } from '@nestjs/common';
import {
  NOTIFICATION_TEMPLATES_FLOOR,
  type NotificationTemplate,
} from '@formsache/shared';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { unreadableTenantNotificationTemplatesLog } from '../../src/tenant-admin/tenant-notification-templates.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { captureStdio } from '../mail/stdio-capture';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **The delivered notification templates are an organisation's own setting,
 * and they are copied rather than inherited** (ADR-0032).
 *
 * Two halves, and the requirement is explicit that one without the other proves
 * nothing:
 *
 * (a) the organisation changes a template → a **newly created** notification
 *     carries the new text;
 * (b) an **existing** notification is left untouched by the same change.
 *
 * (b) is the half the decision of the specification rests on. A form *setting*
 * acts retroactively — that is the point of an inheritance
 * layer. A notification **text** is content somebody wrote and sent out; editing
 * it retroactively would be writing into a mail that has already been promised.
 * So the template is copied at the moment it is applied and the relationship
 * ends there.
 *
 * *Reproduction (run while writing this file):* filling `subject`/`body` in
 * `toView` from the current template instead of from the row — "reading the
 * template at render time" — turns (b) red and leaves (a) green. That is what
 * makes (a) the control rather than a second version of the same test.
 *
 * **The tenant row is written with a raw `prisma` call, not through
 * `PUT /tenant/notification-templates`.** What is exercised here is the *read*
 * path that hands the notification editor its offer
 * (`TenantNotificationTemplatesService.forEditor`); the write route has its
 * own dedicated tests in `test/tenant-admin/tenant-notification-templates.spec.ts`.
 *
 * **There is deliberately no test holding `NOTIFICATION_TEMPLATES_FLOOR`
 * against a stored document.** The requirement rules that out in as many
 * words:
 * such a test would be the proof that two versions of the text exist. That the
 * text stands in exactly one place is proved structurally, in
 * `packages/shared/src/single-source.test.ts`.
 */

const PASSWORD = 'test-password';

const PAGE = '019ff610-0000-7000-8000-0000000000a0';
const EMAIL_QUESTION = '019ff610-0000-7000-8000-000000000002';

function definition(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Seite 1',
        questions: [
          {
            id: EMAIL_QUESTION,
            type: 'email',
            label: 'E-Mail',
            hint: null,
            required: false,
            width: 'full',
          },
        ],
      },
    ],
  };
}

/** The floor's first template, with text no shipped one carries. */
function editedTemplate(): NotificationTemplate {
  const [first] = NOTIFICATION_TEMPLATES_FLOOR;
  if (first === undefined) {
    throw new Error('NOTIFICATION_TEMPLATES_FLOOR is unexpectedly empty');
  }
  return {
    ...first,
    subject: 'Von der Organisation geschriebener Betreff',
    body: '<p>Von der Organisation geschriebener Text.</p>',
  };
}

interface ListResponse {
  readonly notifications: {
    id: string;
    subject: string;
    body: string;
    name: string;
  }[];
  readonly templates: NotificationTemplate[];
}

describe('the delivered templates as an organisation setting', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let formId: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    tenant = await createTenant(testApp.prisma, 'TPL');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    const created = await request(testApp.server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Anmeldung' });
    const form = created.body as { id: string; revision: number };
    formId = form.id;
    await request(testApp.server)
      .put(apiPath(`/forms/${formId}`))
      .set(authedMutation(editor))
      .send({
        title: 'Anmeldung',
        definition: definition(),
        revision: form.revision,
      });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    // Every test in this `describe` shares the one tenant created in
    // `beforeAll`; without resetting its row here, one test's document would
    // decide what the next one reads.
    await app().prisma.tenant.update({
      where: { id: tenant.id },
      data: { notificationTemplates: Prisma.DbNull },
    });
    await app().prisma.notification.deleteMany({});
  });

  /**
   * A raw write onto `tenant.notification_templates` — bypassing the write
   * route (see the module comment) so that this file measures the *read*
   * path in isolation.
   */
  async function setTemplates(
    templates: readonly NotificationTemplate[],
  ): Promise<void> {
    const notificationTemplates = templates as unknown as object[];
    await app().prisma.tenant.update({
      where: { id: tenant.id },
      data: { notificationTemplates },
    });
  }

  async function list(): Promise<ListResponse> {
    const response = await request(app().server)
      .get(apiPath(`/forms/${formId}/notifications`))
      .set('Cookie', cookieHeader(editor));
    expect(response.status).toBe(200);
    return response.body as ListResponse;
  }

  /** Creates a notification the way the editor does: from the offered text. */
  async function createFrom(template: NotificationTemplate): Promise<string> {
    const response = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: template.name,
        triggers: [...template.triggers],
        format: template.format,
        subject: template.subject,
        body: template.body,
        recipients: [{ kind: 'question', questionId: EMAIL_QUESTION }],
        replyTo: null,
      });
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  }

  it('offers the shipped floor for a fixture tenant without a document', async () => {
    // `createTenant` (the test fixture) does not seed a document the way the
    // real `AdminRepository.createTenant` does — see its own comment. `null`
    // is therefore the state to measure here, and the answer is the same the
    // application gives a genuinely undecided row.
    await app().prisma.tenant.update({
      where: { id: tenant.id },
      data: { notificationTemplates: Prisma.DbNull },
    });
    expect((await list()).templates).toEqual([...NOTIFICATION_TEMPLATES_FLOOR]);
  });

  it('offers what the organisation wrote, once there is a document', async () => {
    const edited = editedTemplate();
    await setTemplates([edited]);

    // The load-bearing half: as long as the stored document happens to carry
    // the shipped text, "reads the row" and "reads the constant" are
    // indistinguishable — so the document differs.
    expect((await list()).templates).toEqual([edited]);
  });

  it('offers nothing when the organisation decided to offer nothing', async () => {
    await setTemplates([]);

    // `[]` is a decision, not an absence — it must not fall back to the floor.
    expect((await list()).templates).toEqual([]);
  });

  /** Half (a) — and on its own it would only prove that the row is read. */
  it('gives a newly created notification the changed text', async () => {
    const edited = editedTemplate();
    await setTemplates([edited]);

    const [offered] = (await list()).templates;
    if (offered === undefined) {
      throw new Error('no template was offered');
    }
    const id = await createFrom(offered);

    const stored = await app().prisma.notification.findUniqueOrThrow({
      where: { id },
    });
    expect(stored.subject).toBe(edited.subject);
    expect(stored.body).toBe(edited.body);
  });

  /**
   * Half (b) — the one the decision of the specification stands on.
   *
   * The notification is created **before** the change and read **after** it,
   * out of the very response that also carries the new offer: if anything
   * resolved a template on the way out, the two would agree, and they must not.
   */
  it('leaves an existing notification untouched when the template changes', async () => {
    const [shipped] = (await list()).templates;
    if (shipped === undefined) {
      throw new Error('no template was offered');
    }
    const id = await createFrom(shipped);

    const edited = editedTemplate();
    await setTemplates([edited]);

    const after = await list();
    const row = after.notifications.find(
      (notification) => notification.id === id,
    );
    expect(row?.subject).toBe(shipped.subject);
    expect(row?.body).toBe(shipped.body);
    // The same response offers the new text — so "unchanged" here is not the
    // change having failed to arrive.
    expect(after.templates).toEqual([edited]);
    expect(row?.subject).not.toBe(edited.subject);
  });

  it('keeps an existing notification even when the offer disappears entirely', async () => {
    const [shipped] = (await list()).templates;
    if (shipped === undefined) {
      throw new Error('no template was offered');
    }
    const id = await createFrom(shipped);

    await setTemplates([]);

    const after = await list();
    expect(after.templates).toEqual([]);
    expect(
      after.notifications.find((notification) => notification.id === id)?.body,
    ).toBe(shipped.body);
  });

  it('falls back to the shipped templates when the document does not parse', async () => {
    await app().prisma.tenant.update({
      where: { id: tenant.id },
      data: { notificationTemplates: { vorlageAusM9: true } },
    });

    // Tolerant on purpose: a template decides nothing about a submission, so
    // *fail closed* would only mean "the notifications page of this
    // organisation answers 503" for a page whose own rows are perfectly
    // readable.
    const response = await list();
    expect(response.templates).toEqual([...NOTIFICATION_TEMPLATES_FLOOR]);
    expect(response.notifications).toEqual([]);
  });
});

/**
 * **Unlike the installation-wide reader this replaced, a broken document here
 * is logged on every occurrence** (`tenant-notification-templates.service.ts`
 * explains why: the row belongs to one organisation and is read only behind a
 * session). What is measured is therefore the opposite of the old case —
 * every read produces its own line, naming the organisation.
 */
describe('the unreadable template document is reported per organisation, on every read', () => {
  const REQUESTS = 3;

  it(`says it ${String(REQUESTS)} times over ${String(REQUESTS)} list reads`, async () => {
    const database = await acquireTestDatabase();
    const capture = captureStdio();
    let booted: TestApp | undefined;

    try {
      booted = await createTestApp({
        databaseUrl: database.url,
        logger: new ConsoleLogger(),
      });
      const tenant = await createTenant(booted.prisma, 'TPLB');
      const user = await createUser(booted.prisma, {
        email: 'editor@example.org',
        password: PASSWORD,
        tenants: [tenant],
      });
      const session = await openSession(booted, user.id, tenant.id);

      const created = await request(booted.server)
        .post(apiPath('/forms'))
        .set(authedMutation(session))
        .send({ title: 'Zähltest' });
      const form = created.body as { id: string };

      await booted.prisma.tenant.update({
        where: { id: tenant.id },
        data: { notificationTemplates: { vorlageAusM9: true } },
      });

      for (let round = 0; round < REQUESTS; round += 1) {
        const response = await request(booted.server)
          .get(apiPath(`/forms/${form.id}/notifications`))
          .set('Cookie', cookieHeader(session));
        expect(response.status).toBe(200);
      }

      expect(
        capture.countOf(unreadableTenantNotificationTemplatesLog(tenant.id)),
      ).toBe(REQUESTS);
    } finally {
      capture.restore();
      await booted?.close();
      await database.release();
    }
  }, 180_000);
});
