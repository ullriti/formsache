import request from 'supertest';
import { expect } from 'vitest';

import { apiPath, type TestApp } from '../support/create-test-app';
import { authedMutation } from '../support/http';

/**
 * A published form for the incident reproductions.
 *
 * **Through the real routes, not through `prisma.form.create`.** An incident is
 * only reproduced once the way there was the way of the application: the
 * notification comes about through the route an editor uses, and the response
 * comes in through the public endpoint. A directly written record would bring
 * the incident about as well, but over a path that does not exist in
 * operation — and the evidence a reproduction demands is a statement about
 * operation.
 *
 * The price is the revisions, that is the optimistic locks from Konzept
 * no. 21, that every one of these routes demands.
 */

export interface PublishedForm {
  readonly id: string;
  readonly slug: string;
  /** The form's one question — the key in the `answers` object. */
  readonly nameQuestionId: string;
}

export interface PublishOptions {
  readonly title: string;
  /**
   * Fixed recipient address of an active notification, or left out for a form
   * that sends **nothing**.
   *
   * A `.invalid` address is deliberate: even if a suite were ever to end up at
   * a real transport, the name cannot resolve and nothing leaves the machine.
   */
  readonly recipient?: string;
}

/** Fixed identifiers — readable in a failed assertion. */
const PAGE = '019ffb00-0000-7000-8000-000000000010';
const NAME_QUESTION = '019ffb00-0000-7000-8000-000000000011';

export async function publishFormWithNotification(
  app: TestApp,
  editor: string,
  options: PublishOptions,
): Promise<PublishedForm> {
  const created = await request(app.server)
    .post(apiPath('/forms'))
    .set(authedMutation(editor))
    .send({ title: options.title });
  expect(created.status).toBe(201);
  const form = created.body as {
    id: string;
    revision: number;
    publicSlug: string;
  };

  const saved = await request(app.server)
    .put(apiPath(`/forms/${form.id}`))
    .set(authedMutation(editor))
    .send({
      title: options.title,
      definition: definition(),
      revision: form.revision,
    });
  expect(saved.status).toBe(200);

  if (options.recipient !== undefined) {
    const notification = await request(app.server)
      .post(apiPath(`/forms/${form.id}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Meldung an die Geschäftsführung',
        subject: 'Neue Anmeldung',
        body: 'Es ist eine Anmeldung eingegangen.',
        replyTo: null,
        recipients: [{ kind: 'literal', address: options.recipient }],
      });
    expect(notification.status).toBe(201);
  }

  const published = await request(app.server)
    .post(apiPath(`/forms/${form.id}/publish`))
    .set(authedMutation(editor))
    .send({ revision: (saved.body as { revision: number }).revision });
  expect(published.status).toBe(200);

  return { id: form.id, slug: form.publicSlug, nameQuestionId: NAME_QUESTION };
}

/**
 * One page, one question — enough to submit a response and export it later.
 *
 * Written out in full because the form schema in `@formsache/shared` is a
 * `strictObject`: a missing field ends the save with 400 instead of with a
 * half-valid form.
 */
function definition(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            id: NAME_QUESTION,
            type: 'text',
            label: 'Zuname',
            hint: null,
            required: true,
            width: 'full',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
    ],
  };
}
