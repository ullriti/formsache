import { questionPlaceholderToken } from '@formsache/shared';
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
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';

/**
 * The requirement — **a placeholder must not point into thin air**.
 *
 * The proof is written exactly as the requirement words it: publishing with an
 * orphaned placeholder is refused **without a `form_version` row being
 * written**, counted before and after; after the placeholder is taken out, the
 * same publish succeeds. The row count is the load-bearing assertion — a
 * refusal that had already minted a version would leave the lock in place for
 * the next attempt with the damage done, and a test that only read the status
 * code would not notice.
 *
 * **Negative probe, measured while writing this file.** Removing the
 * `findOrphanedPlaceholders` block from `FormsService.publish()` turns exactly
 * the three refusal cases red — body, recipient list, subject — while the three
 * that must stay green stay green: „nach dem Entfernen gelingt dasselbe
 * Veröffentlichen", „das Umbenennen lässt die Benachrichtigung unberührt" and
 * „eine nicht referenzierte Frage darf verschwinden". That asymmetry is what
 * makes the green ones controls rather than repetitions: they show the lock is
 * closed around the case it is for and open everywhere else.
 *
 * The **recipient list** has a case of its own on purpose. It is the one an
 * implementation forgets: a body with a gap in it is embarrassing, a
 * notification without a recipient is a mail with no destination.
 */

const PASSWORD = 'test-password';

const PAGE = '019ff700-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ff700-0000-7000-8000-000000000001';
const EMAIL_QUESTION = '019ff700-0000-7000-8000-000000000002';

const EMAIL_TOKEN = questionPlaceholderToken(EMAIL_QUESTION);

const questionBase = { hint: null, required: false, width: 'full' as const };

const nameQuestion = {
  ...questionBase,
  id: NAME_QUESTION,
  type: 'text',
  label: 'Name',
  minLength: null,
  maxLength: null,
  pattern: null,
};

const emailQuestion = {
  ...questionBase,
  id: EMAIL_QUESTION,
  type: 'email',
  label: 'E-Mail',
};

/** The same question, same id, different caption — the specification's free case. */
const renamedEmailQuestion = { ...emailQuestion, label: 'E-Mail-Adresse' };

function withQuestions(questions: readonly unknown[]): unknown {
  return { pages: [{ id: PAGE, title: 'Seite 1', questions }] };
}

describe('publish lock on orphaned placeholders ', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let admin: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'C1AT');
    const user = await createUser(testApp.prisma, {
      email: 'publish-lock@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    admin = await openSession(testApp, user.id, alpha.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Creates a form and returns id plus the revision the next write must name. */
  async function createForm(
    title: string,
  ): Promise<{ id: string; revision: number }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(admin))
      .send({ title });
    expect(created.status).toBe(201);
    return created.body as { id: string; revision: number };
  }

  async function saveDraft(
    formId: string,
    revision: number,
    questions: readonly unknown[],
    title = 'Anmeldung',
  ): Promise<number> {
    const saved = await request(app().server)
      .put(apiPath(`/forms/${formId}`))
      .set(authedMutation(admin))
      .send({ title, definition: withQuestions(questions), revision });
    expect(saved.status).toBe(200);
    return (saved.body as { revision: number }).revision;
  }

  function publish(formId: string, revision: number): request.Test {
    return request(app().server)
      .post(apiPath(`/forms/${formId}/publish`))
      .set(authedMutation(admin))
      .send({ revision });
  }

  function preview(formId: string): request.Test {
    return request(app().server)
      .get(apiPath(`/forms/${formId}/publish-preview`))
      .set(authedMutation(admin));
  }

  function versionCount(formId: string): Promise<number> {
    return app().prisma.formVersion.count({ where: { formId } });
  }

  async function addNotification(
    formId: string,
    body: object,
  ): Promise<{ id: string }> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(admin))
      // `replyTo` first, so a caller can still say something else about it:
      // the field is required and nullable without a default, and
      // this suite has nothing to say about it.
      .send({ replyTo: null, ...body });
    expect(created.status).toBe(201);
    return created.body as { id: string };
  }

  /**
   * A published form with both questions and a notification pointing at the
   * e-mail one — the starting point of every case below.
   *
   * Returns the revision a publish of the *next* draft has to name.
   */
  async function publishedFormWith(
    notification: object,
    title: string,
  ): Promise<{ formId: string; revision: number }> {
    const form = await createForm(title);
    const saved = await saveDraft(
      form.id,
      form.revision,
      [nameQuestion, emailQuestion],
      title,
    );
    const published = await publish(form.id, saved);
    expect(published.status).toBe(200);

    await addNotification(form.id, notification);
    return {
      formId: form.id,
      revision: (published.body as { revision: number }).revision,
    };
  }

  it('refuses the publish when the body still names the removed question', async () => {
    const { formId, revision } = await publishedFormWith(
      {
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: `Wir schreiben an ${EMAIL_TOKEN}.`,
      },
      'Body-Platzhalter',
    );

    const next = await saveDraft(
      formId,
      revision,
      [nameQuestion],
      'Body-Platzhalter',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(422);
    const message = (response.body as { message: string }).message;
    // Names **the notification and the placeholder** — otherwise the editor
    // searches n texts by hand for a token they cannot see.
    expect(message).toContain('Bestätigung');
    expect(message).toContain(EMAIL_TOKEN);
    // …and the caption the question had, so the sentence is readable as well
    // as precise.
    expect(message).toContain('E-Mail');

    // The load-bearing half of the requirement: no version was minted.
    expect(await versionCount(formId)).toBe(before);
    // Nor did the revision move — a refusal that bumped it would log the
    // editor out of their next save.
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
    });
    expect(form.revision).toBe(next);
  });

  it('refuses it for the recipient list too — the one that is forgotten', async () => {
    const { formId, revision } = await publishedFormWith(
      {
        name: 'An die Aktive',
        subject: 'Anmeldung eingegangen',
        // Nothing in subject or body points anywhere: only the recipient does,
        // and a mail without a destination is worse than one with a gap.
        body: 'Danke für die Anmeldung.',
        recipients: [{ kind: 'question', questionId: EMAIL_QUESTION }],
      },
      'Empfänger-Platzhalter',
    );

    const next = await saveDraft(
      formId,
      revision,
      [nameQuestion],
      'Empfänger-Platzhalter',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(422);
    const message = (response.body as { message: string }).message;
    expect(message).toContain('An die Aktive');
    expect(message).toContain(EMAIL_TOKEN);
    expect(message).toContain('Empfängerliste');
    expect(await versionCount(formId)).toBe(before);
  });

  it('refuses it for the subject as well', async () => {
    const { formId, revision } = await publishedFormWith(
      {
        name: 'Betreff-Fall',
        subject: `Anmeldung von ${EMAIL_TOKEN}`,
        body: 'Danke.',
      },
      'Betreff-Platzhalter',
    );

    const next = await saveDraft(
      formId,
      revision,
      [nameQuestion],
      'Betreff-Platzhalter',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(422);
    expect((response.body as { message: string }).message).toContain('Betreff');
    expect(await versionCount(formId)).toBe(before);
  });

  /**
   * The **control** of the negative probe, and it is written so that it stays
   * green when the lock is removed.
   *
   * It therefore does *not* assert the refusal first — the case above does
   * that. This one only says: with the placeholder gone, the very same publish
   * goes through. A test that checked both halves would go red together with
   * the first one and prove nothing about where the lock stops.
   */
  it('publishes once the placeholder is taken out', async () => {
    const { formId, revision } = await publishedFormWith(
      {
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: `Wir schreiben an ${EMAIL_TOKEN}.`,
        recipients: [{ kind: 'question', questionId: EMAIL_QUESTION }],
      },
      'Reparatur',
    );

    const next = await saveDraft(formId, revision, [nameQuestion], 'Reparatur');
    const before = await versionCount(formId);

    // The repair the message asks for: placeholder out of the text, question
    // recipient out of the list.
    const notification = await app().prisma.notification.findFirstOrThrow({
      where: { formId },
    });
    const repaired = await request(app().server)
      .put(apiPath(`/forms/${formId}/notifications/${notification.id}`))
      .set(authedMutation(admin))
      .send({
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: 'Wir haben Ihre Anmeldung.',
        recipients: [{ kind: 'literal', address: 'buero@example.org' }],
        replyTo: null,
      });
    expect(repaired.status).toBe(200);

    // **The same publish** the case above is refused: same draft, same
    // revision, only the notification repaired.
    const response = await publish(formId, next);
    expect(response.status).toBe(200);
    expect(await versionCount(formId)).toBe(before + 1);
  });

  it('leaves the notification alone when the question is merely renamed', async () => {
    const { formId, revision } = await publishedFormWith(
      {
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: `Wir schreiben an ${EMAIL_TOKEN}.`,
        recipients: [{ kind: 'question', questionId: EMAIL_QUESTION }],
      },
      'Umbenennen',
    );

    const next = await saveDraft(
      formId,
      revision,
      [nameQuestion, renamedEmailQuestion],
      'Umbenennen',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    // The id binds, not the caption — so renaming is free, and
    // **only** removing trips the lock.
    expect(response.status).toBe(200);
    expect(await versionCount(formId)).toBe(before + 1);

    const stored = await app().prisma.notification.findFirstOrThrow({
      where: { formId },
    });
    expect(stored.body).toContain(EMAIL_TOKEN);
    expect(stored.recipients).toEqual([
      { kind: 'question', questionId: EMAIL_QUESTION },
    ]);
  });

  /**
   * **The preview says it too — and until this case existed, nothing on the
   * server said so.**
   *
   * `publishPreview()` carries the same finding as the refusal so the editor
   * reads it *before* pressing the button (`forms.service.ts`).
   * That half had no test at all: setting `blocked: []` in the service left the
   * whole web suite **and** the whole shared suite green, because the web tests
   * feed the view a payload of their own and never ask the server for one. A
   * promise proven only against a hand-written fixture is a promise about the
   * fixture.
   *
   * Checked here, not in a file of its own: it is the same lock, the same
   * fixtures and the same three places, and a second suite would be a second
   * set of forms to keep in step.
   *
   * The assertions name **all three** parts the requirement asks the message to
   * carry — notification, token, place — because `blocked.length === 1` would
   * stay green with any of them dropped.
   */
  it('reports the same finding in the publish preview, before the button', async () => {
    const { formId, revision } = await publishedFormWith(
      {
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: `Wir schreiben an ${EMAIL_TOKEN}.`,
        recipients: [{ kind: 'question', questionId: EMAIL_QUESTION }],
      },
      'Vorschau',
    );

    // Nothing blocks while the question is still in the draft — the control
    // that keeps the next assertion from being „blocked is always non-empty".
    const before = await preview(formId);
    expect(before.status).toBe(200);
    expect((before.body as { blocked: unknown[] }).blocked).toEqual([]);

    await saveDraft(formId, revision, [nameQuestion], 'Vorschau');

    const blocked = await preview(formId);
    expect(blocked.status).toBe(200);
    expect((blocked.body as { blocked: unknown[] }).blocked).toEqual([
      {
        // The field carries two shapes — a dangling placeholder
        // and a Bedingung whose source no longer resolves — and the
        // discriminator is what keeps the dialog from rendering one as the
        // other.
        kind: 'placeholder',
        notificationName: 'Bestätigung',
        token: EMAIL_TOKEN,
        // The caption the version in force still knows — an id is precise and
        // unreadable, a caption is readable and ambiguous, and both together
        // are what somebody can act on.
        label: 'E-Mail',
        // Body **and** recipient list, in that order: the preview has to name
        // every place, or the editor repairs one and is refused again.
        places: ['body', 'recipients'],
      },
    ]);

    // A preview is a read: it must not have minted anything.
    expect(await versionCount(formId)).toBe(1);
  });

  it('lets an unreferenced question disappear', async () => {
    const { formId, revision } = await publishedFormWith(
      {
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: `Wir schreiben an ${EMAIL_TOKEN}.`,
        recipients: [{ kind: 'question', questionId: EMAIL_QUESTION }],
      },
      'Fremde Frage',
    );

    // The **name** question goes, which nothing points at. A lock that fired
    // here would be a lock on publishing rather than on dangling placeholders.
    const next = await saveDraft(
      formId,
      revision,
      [emailQuestion],
      'Fremde Frage',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(200);
    expect(await versionCount(formId)).toBe(before + 1);
  });
});
