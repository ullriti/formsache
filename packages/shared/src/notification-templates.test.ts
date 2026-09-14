import { describe, expect, it } from 'vitest';

import {
  notificationCreateSchema,
  systemPlaceholderToken,
  type NotificationTemplate,
} from './mail.ts';
import { unknownPlaceholders } from './mail-template.ts';
import {
  NOTIFICATION_TEMPLATES_FLOOR,
  NOTIFICATION_TEMPLATE_LIMIT,
  acceptsTemplate,
  parseNotificationTemplatesDocument,
  tenantNotificationTemplatesResponseSchema,
  updateTenantNotificationTemplatesRequestSchema,
} from './notification-templates.ts';

/**
 * The three delivered templates.
 *
 * What is worth testing about a constant is not its wording but the three
 * promises made about it: that applying one produces a notification the API
 * would accept, that every placeholder in it is one this system resolves, and
 * that it is only ever offered where there is nothing to overwrite.
 *
 * The last one is the rule with a cost behind it — a picker that replaces typed
 * text is a data-loss button — so it is checked from both sides.
 */

function templateOf(id: string): NotificationTemplate {
  const template = NOTIFICATION_TEMPLATES_FLOOR.find(
    (candidate) => candidate.id === id,
  );
  if (template === undefined) {
    throw new Error(`Keine Vorlage mit der id ${id}.`);
  }
  return template;
}

describe('the delivered notification templates', () => {
  it('offers exactly the three the organisation needs on day one', () => {
    expect(
      NOTIFICATION_TEMPLATES_FLOOR.map((template) => template.name),
    ).toEqual([
      'Bestätigung an Teilnehmer',
      'Meldung ans Büro',
      'Änderungsmeldung',
    ]);
  });

  it('produces a notification the API accepts, for each of them', () => {
    for (const template of NOTIFICATION_TEMPLATES_FLOOR) {
      // Recipients are deliberately not part of a template (they name a
      // question of *this* form), so the parse is done with the empty list the
      // editor starts from.
      const parsed = notificationCreateSchema.safeParse({
        name: template.name,
        triggers: [...template.triggers],
        format: template.format,
        recipients: [],
        subject: template.subject,
        body: template.body,
        // A template names no reply-to address — it is nothing that a
        // shared text could bring along. The key nevertheless has to
        // stand there: required and nullable, without a default value.
        replyTo: null,
        active: true,
      });
      expect(
        parsed.success,
        `${template.id}: ${parsed.error?.message ?? ''}`,
      ).toBe(true);
    }
  });

  it('uses no placeholder this system would leave standing in the mail', () => {
    for (const template of NOTIFICATION_TEMPLATES_FLOOR) {
      // Without a set of known question ids every well-formed `{{frage:…}}`
      // counts as known — which is right here, since a shared template can
      // never name one.
      expect(unknownPlaceholders(template.subject)).toEqual([]);
      expect(unknownPlaceholders(template.body)).toEqual([]);
    }
  });

  /** The half that is about the template itself. */
  it('gives „Änderungsmeldung" the edit trigger and the change placeholder', () => {
    const change = templateOf('change');

    expect(change.triggers).toEqual(['edit']);
    expect(change.subject).not.toBe('');
    expect(change.body).toContain(systemPlaceholderToken('aenderungen'));
    // It is the *only* one that fires on an edit, and the only one that says
    // what changed: a confirmation carrying an empty change block would be the
    // silent-nonsense case this placeholder exists to avoid.
    for (const other of NOTIFICATION_TEMPLATES_FLOOR.filter(
      (candidate) => candidate.id !== 'change',
    )) {
      expect(other.triggers).toEqual(['submit']);
      expect(other.body).not.toContain(systemPlaceholderToken('aenderungen'));
    }
  });

  it('builds the participant confirmation from answers and the edit link', () => {
    const confirmation = templateOf('confirmation');

    expect(confirmation.toSubmitter).toBe(true);
    expect(confirmation.body).toContain(systemPlaceholderToken('antworten'));
    expect(confirmation.body).toContain(systemPlaceholderToken('bearbeiten'));
  });

  it('builds the office notice from form, date and answers', () => {
    const office = templateOf('office');

    expect(office.toSubmitter).toBe(false);
    expect(office.subject + office.body).toContain(
      systemPlaceholderToken('formular'),
    );
    expect(office.body).toContain(systemPlaceholderToken('datum'));
    expect(office.body).toContain(systemPlaceholderToken('antworten'));
  });
});

/**
 * The stored document — `tenant.notification_templates`.
 *
 * **Deliberately not a test that holds the constant against a tenant row.**
 * That would defeat the purpose: such a test would be the proof
 * that there are two versions of the text. What is checked here is that the
 * floor is a *valid* document (so „nichts entschieden" and „so geschrieben"
 * cannot be two different shapes) and what the schema refuses.
 */
describe('the stored template document', () => {
  it('accepts the shipped floor unchanged', () => {
    expect(
      parseNotificationTemplatesDocument(NOTIFICATION_TEMPLATES_FLOOR),
    ).toEqual(NOTIFICATION_TEMPLATES_FLOOR);
  });

  it('accepts the empty list — „diese Organisation bietet keine Vorlagen an"', () => {
    // A different statement from „nichts entschieden", which is the absent
    // column and is answered by the floor. The two must not collapse into one.
    expect(parseNotificationTemplatesDocument([])).toEqual([]);
  });

  it('refuses two templates under one id', () => {
    const [first] = NOTIFICATION_TEMPLATES_FLOOR;
    if (first === undefined) {
      throw new Error('NOTIFICATION_TEMPLATES_FLOOR is unexpectedly empty');
    }
    expect(() =>
      parseNotificationTemplatesDocument([first, { ...first, name: 'Zweite' }]),
    ).toThrow();
  });

  it('refuses more templates than one picker can offer', () => {
    const [first] = NOTIFICATION_TEMPLATES_FLOOR;
    if (first === undefined) {
      throw new Error('NOTIFICATION_TEMPLATES_FLOOR is unexpectedly empty');
    }
    const many = Array.from(
      { length: NOTIFICATION_TEMPLATE_LIMIT + 1 },
      (_unused, index) => ({ ...first, id: `t${String(index)}` }),
    );
    expect(() => parseNotificationTemplatesDocument(many)).toThrow();
  });

  it('refuses a template whose subject or body is empty', () => {
    const [first] = NOTIFICATION_TEMPLATES_FLOOR;
    if (first === undefined) {
      throw new Error('NOTIFICATION_TEMPLATES_FLOOR is unexpectedly empty');
    }
    // A template is „usable as it is" (rule 3 of the module comment); an empty
    // body is a picker entry that does nothing but overwrite the name.
    expect(() =>
      parseNotificationTemplatesDocument([{ ...first, body: '' }]),
    ).toThrow();
    expect(() =>
      parseNotificationTemplatesDocument([{ ...first, subject: '' }]),
    ).toThrow();
  });

  it('refuses a key this application does not know', () => {
    const [first] = NOTIFICATION_TEMPLATES_FLOOR;
    if (first === undefined) {
      throw new Error('NOTIFICATION_TEMPLATES_FLOOR is unexpectedly empty');
    }
    expect(() =>
      parseNotificationTemplatesDocument([
        { ...first, replyTo: 'x@example.org' },
      ]),
    ).toThrow();
  });

  it('refuses „Bei Zwischenspeichern" in a template, as the write schema does', () => {
    const [first] = NOTIFICATION_TEMPLATES_FLOOR;
    if (first === undefined) {
      throw new Error('NOTIFICATION_TEMPLATES_FLOOR is unexpectedly empty');
    }
    // The same narrow trigger set the API accepts: a template offering a
    // trigger no notification may carry would produce a draft the server then
    // refuses to save.
    expect(() =>
      parseNotificationTemplatesDocument([{ ...first, triggers: ['save'] }]),
    ).toThrow();
  });
});

/**
 * **A template is offered only while there is nothing to lose.**
 *
 * Both directions, because only the pair says anything: „wird angeboten" alone
 * would be green for a picker that is always there, and „wird nicht angeboten"
 * alone for one that never is.
 */
describe('when a template may be applied', () => {
  it('is offered for an empty text', () => {
    expect(acceptsTemplate('')).toBe(true);
    // A stray newline is not text anybody meant to keep.
    expect(acceptsTemplate('\n  \n')).toBe(true);
  });

  it('is not offered once anything has been written', () => {
    expect(acceptsTemplate('Hallo,')).toBe(false);
    // Not even for text that is *only* a placeholder: it was still typed, and
    // an overwritten template is as lost as an overwritten sentence.
    expect(acceptsTemplate(systemPlaceholderToken('antworten'))).toBe(false);
  });
});

/**
 * **The wire contract of the write path** (ADR-0032).
 *
 * What is checked is what a schema really promises — not that a valid
 * document is valid, but that the three limits hold at which a
 * route would give way without them: count, id uniqueness and the
 * counter.
 */
describe("the write contract of an organisation's templates", () => {
  const template: NotificationTemplate = {
    id: 'eigene',
    name: 'Eigene Vorlage',
    description: 'Wofür sie gedacht ist.',
    triggers: ['submit'],
    format: 'html',
    subject: 'Betreff',
    body: 'Rumpf',
    toSubmitter: false,
  };

  it('takes a full document with its lock', () => {
    const parsed = updateTenantNotificationTemplatesRequestSchema.parse({
      templates: [template],
      lock: 3,
    });

    expect(parsed.lock).toBe(3);
    expect(parsed.templates).toHaveLength(1);
  });

  /**
   * **The empty list is a decision** — „diese Installation bietet
   * keine Vorlagen an" — and not „nichts entschieden". The latter is the
   * *absence* of the column and has no spelling on the wire.
   */
  it('accepts the empty list as a decision', () => {
    expect(
      updateTenantNotificationTemplatesRequestSchema.parse({
        templates: [],
        lock: 1,
      }).templates,
    ).toStrictEqual([]);
  });

  it('refuses more than the limit and two templates under one id', () => {
    expect(() =>
      updateTenantNotificationTemplatesRequestSchema.parse({
        templates: Array.from(
          { length: NOTIFICATION_TEMPLATE_LIMIT + 1 },
          (_, index) => ({ ...template, id: `v${String(index)}` }),
        ),
        lock: 1,
      }),
    ).toThrow();

    expect(() =>
      updateTenantNotificationTemplatesRequestSchema.parse({
        templates: [template, template],
        lock: 1,
      }),
    ).toThrow();
  });

  /**
   * **The lock is never optional.** A client that were allowed to leave it out would be
   * a client that silently overwrites somebody else's change — exactly what
   * the counter was introduced for in the same change.
   */
  it('refuses a write without a lock', () => {
    expect(() =>
      updateTenantNotificationTemplatesRequestSchema.parse({
        templates: [template],
      }),
    ).toThrow();
  });

  /**
   * `decided` separates „das hat hier jemand hinterlegt" from „das ist die
   * Auslieferung". Without the field both would look the same, and nobody would know whether
   * they are changing something or confirming something.
   */
  it('reads an answer that says whether the row decides', () => {
    const parsed = tenantNotificationTemplatesResponseSchema.parse({
      templates: [...NOTIFICATION_TEMPLATES_FLOOR],
      decided: false,
      lock: 1,
    });

    expect(parsed.decided).toBe(false);
    expect(parsed.templates).toHaveLength(NOTIFICATION_TEMPLATES_FLOOR.length);
  });
});
