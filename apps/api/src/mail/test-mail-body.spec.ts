import { describe, expect, it } from 'vitest';

import { TEST_MAIL_SUBJECT, testMailBody } from './test-mail.service';

/**
 * **What a test mail says** (item 20 of the second review round).
 *
 * Before, it was two sentences of plain text, and it visibly answered neither of the two
 * questions one presses it for: *did it arrive* (then the connection
 * stands) and *whom did it come from* (then the sender address is right). Both
 * now stand in the body, plus the time — without it the second test mail
 * in the mailbox cannot be told apart from the first.
 *
 * What is checked is the pure function, not the dispatch: the way through
 * `MailIdentityService`, `mail_log` and the transport stands in
 * `test/mail/test-mail.spec.ts`, against a real server.
 *
 * ⚠️ **Both versions, always.** `text` stays set alongside `html`; a
 * mail client without HTML would otherwise get an empty message — and an empty
 * test mail answers its question with "yes, but it says nothing".
 */

const TRIGGERED_AT = new Date('2026-08-17T09:30:00.000Z');

describe('testMailBody', () => {
  const tenant = {
    source: 'tenant' as const,
    organisation: 'Musterstadt Stuttgart',
    senderAddress: 'post@musterstadt.example',
    triggeredAt: TRIGGERED_AT,
  };

  it('sagt in beiden Fassungen, was diese Mail belegt', () => {
    const body = testMailBody(tenant);

    for (const [name, fassung] of [
      ['text', body.text],
      ['html', body.html],
    ] as const) {
      // The actual statement: connection **and** sender address.
      expect(fassung, `${name}: die Verbindung`).toContain(
        'Verbindung zum eingetragenen Mailserver steht',
      );
      expect(fassung, `${name}: die Absenderadresse`).toContain(
        'post@musterstadt.example',
      );
      // From whom — and when.
      expect(fassung, `${name}: die Organisation`).toContain(
        'Musterstadt Stuttgart',
      );
      expect(fassung, `${name}: der Zeitpunkt`).toContain('17.08.2026');
      // And the demarcation that makes this row unmistakable in the mail log:
      // it is not a registration confirmation.
      expect(fassung, `${name}: die Abgrenzung`).toContain(
        'bestätigt keine Anmeldung',
      );
    }
  });

  it('hält die Klartextfassung frei von Auszeichnungen und die HTML-Fassung nicht', () => {
    const body = testMailBody(tenant);

    expect(body.text).not.toContain('<');
    expect(body.html).toContain('<p');
    expect(body.html).toContain('<table');
  });

  /**
   * On skimming the inbox, the subject says what it is about — and
   * still carries the marking by which a test mail is recognisable in the
   * mail log.
   */
  it('führt einen Betreff, der die Sache benennt', () => {
    expect(TEST_MAIL_SUBJECT).toContain('Formsache');
    expect(TEST_MAIL_SUBJECT).toContain('Testmail');
    expect(TEST_MAIL_SUBJECT).toContain('funktioniert');
  });

  /**
   * **Which mail server was checked is in it** — and the two versions
   * are distinguishable. Without this case, "from the instance" and "from
   * the organisation" would remain the same text, and the system test mail would not
   * answer the question it exists for (ADR-0013, continuation 29a).
   */
  it('unterscheidet die Instanz von der Organisation', () => {
    const own = testMailBody(tenant);
    const system = testMailBody({ ...tenant, source: 'system' });

    expect(own.text).toContain('Mailserver der Organisation');
    expect(system.text).toContain('Mailserver der Instanz');
    expect(system.text).toContain('Systemverwaltung');
    expect(own.text).not.toBe(system.text);
  });

  /**
   * The name of the organisation comes from a database row and is inserted into
   * HTML — hence defused. The table goes through the same function
   * that a confirmation uses for `{{antworten}}`; this row records
   * that the body around it does so too.
   */
  it('entschärft den Namen der Organisation im HTML-Zweig', () => {
    const body = testMailBody({
      ...tenant,
      organisation: '<script>alert(1)</script>',
    });

    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });
});
