import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { SmtpBlock } from '@formsache/shared';

import { SecretBoxService } from '../common/secret-box/secret-box.service';
import {
  systemSecretContext,
  tenantDefaultsContext,
  tenantOidcContext,
  tenantSmtpContext,
} from '../common/secret-box/secret-context';
import {
  MAIL_CONFIG_UNPARSABLE_REASON,
  MAIL_PASSWORD_UNREADABLE_REASON,
  MailConfigUnreadableError,
  MailSecretsService,
  type SealableSmtpBlock,
  type SealedSmtpPassword,
} from './mail-secrets.service';

/**
 * **The requirement, at the level where the contexts are decided.**
 *
 * The end-to-end half — no plaintext in the column, none in a payload, none in
 * a log — is proven where a real save and a real send happen
 * (`test/mail/system-mail.spec.ts` and `test/mail/smtp-credentials.spec.ts`).
 * What is proven *here* is the part those cannot see: that a sealed value bound
 * to one holder does not open under another, in **every** direction that
 * matters.
 */

const KEY = Buffer.alloc(32, 7);

const TENANT_A = '019ff600-0000-7000-8000-0000000000b1';
const TENANT_B = '019ff600-0000-7000-8000-0000000000b2';

/** A password per run, never a fixed word — see the requirement, the evidence. */
function mintPassword(): string {
  return `pw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

const block = (password: string): SmtpBlock => ({
  host: 'mail.example.invalid',
  port: 587,
  secure: false,
  auth: { user: 'postmaster', password },
  from: 'post@example.invalid',
});

/**
 * The same block on its way **in**, where a password says where it came from
 * (`SmtpPasswordWrite`). `'typed'` is „somebody entered this just now", which is
 * what every case below does; the other arm, „the one already in the column",
 * is exercised where a save keeps a password it was not sent
 * (`test/tenant-admin/smtp-config.spec.ts`).
 */
const written = (password: string): SealableSmtpBlock => ({
  ...block(password),
  auth: { user: 'postmaster', password: { kind: 'typed', value: password } },
});

function harness(): { secrets: MailSecretsService; box: SecretBoxService } {
  const box = new SecretBoxService(KEY);
  // The service holds its own `Logger`; the prototype is what a spy sits on.
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return { secrets: new MailSecretsService(box), box };
}

describe('the SMTP password is a database secret ', () => {
  it('makes a round trip through the system row', () => {
    const { secrets } = harness();
    const password = mintPassword();

    const stored = secrets.sealSystemBlock(block(password));
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(secrets.openSystemBlock(stored)?.auth?.password).toBe(password);
  });

  it('makes a round trip through an organisation’s row', () => {
    const { secrets } = harness();
    const password = mintPassword();

    const stored = secrets.sealTenantBlock(written(password), TENANT_A);
    expect(JSON.stringify(stored)).not.toContain(password);

    const opened = secrets.openTenantBlock(stored, TENANT_A);
    expect(opened?.auth?.password).toBe(password);
  });

  /**
   * **The reproduction, in the direction „across the organisation boundary".**
   * Take the tenant out of the context and this passes: the value of
   * Organisation A opens in the row of Organisation B, and tenant isolation — a
   * security boundary in this project, not a display question — has a hole in it
   * that no behavioural test sees.
   */
  it('does not open Organisation A’s mail password in Organisation B’s row', () => {
    const { secrets } = harness();
    const stored = secrets.sealTenantBlock(written(mintPassword()), TENANT_A);

    expect(() => secrets.openTenantBlock(stored, TENANT_B)).toThrow(
      MailConfigUnreadableError,
    );
  });

  /**
   * **The reproduction, in the direction „the field out of the AAD".** A sealed
   * OIDC client secret, moved by a raw write into the SMTP block of the **same**
   * Organisation. Without `smtp.password` in the context the two are
   * interchangeable, and the mail server of that organisation would be handed
   * somebody's client secret — or, worse in the other direction, an editor's
   * page that may show an access word in clear would show it.
   */
  it('does not open a sealed OIDC client secret as a mail password', () => {
    const { secrets, box } = harness();
    const clientSecret = mintPassword();
    const smuggled = {
      ...block(
        box.seal(
          clientSecret,
          tenantOidcContext(TENANT_A, 'oidc.client_secret'),
        ),
      ),
    };

    expect(() => secrets.openTenantBlock(smuggled, TENANT_A)).toThrow(
      MAIL_PASSWORD_UNREADABLE_REASON,
    );
  });

  /** …and the same for the access word of that organisation's own standards. */
  it('does not open a sealed access word as a mail password', () => {
    const { secrets, box } = harness();
    const smuggled = {
      ...block(
        box.seal(
          mintPassword(),
          tenantDefaultsContext(TENANT_A, 'access.password'),
        ),
      ),
    };

    expect(() => secrets.openTenantBlock(smuggled, TENANT_A)).toThrow(
      MailConfigUnreadableError,
    );
  });

  /**
   * The holder that has no id (ADR-0013 no. 6): the installation's own password
   * and an organisation's are two secrets, and **neither** opens where the other lives.
   */
  it('keeps the installation’s mail password out of every organisation’s row, and back', () => {
    const { secrets } = harness();
    const systemStored = secrets.sealSystemBlock(block(mintPassword()));
    const tenantStored = secrets.sealTenantBlock(
      written(mintPassword()),
      TENANT_A,
    );

    expect(() =>
      secrets.openTenantBlock(systemStored as unknown as SmtpBlock, TENANT_A),
    ).toThrow(MailConfigUnreadableError);
    expect(() =>
      secrets.openSystemBlock(tenantStored as unknown as SmtpBlock),
    ).toThrow(MailConfigUnreadableError);
  });

  /** The contexts are the ones `secret-context.ts` builds — not near-misses. */
  it('seals under exactly the documented contexts', () => {
    const { secrets, box } = harness();
    const password = mintPassword();

    const system = secrets.sealSystemBlock(block(password)) as {
      auth: { password: string };
    };
    expect(
      box.open(system.auth.password, systemSecretContext('smtp.password')),
    ).toBe(password);

    const tenant = secrets.sealTenantBlock(written(password), TENANT_A) as {
      auth: { password: string };
    };
    expect(
      box.open(
        tenant.auth.password,
        tenantSmtpContext(TENANT_A, 'smtp.password'),
      ),
    ).toBe(password);
  });
});

describe('what a stored document may be (ADR-0013 Nr. 4 and 5, ADR-0023)', () => {
  it('reads an empty Organisation column as „kein Mailserver" and writes it back as NULL', () => {
    const { secrets } = harness();
    // **No longer „erbt vom System"** (ADR-0023): the same empty column, the
    // other answer. The caller makes `withhold` out of it, never the block of
    // the installation.
    expect(secrets.openTenantBlock(null, TENANT_A)).toBeNull();
    // NULL is the canonical spelling, so clearing the mail server clears the
    // column instead of writing a second way of saying the same thing.
    expect(secrets.sealTenantBlock(null, TENANT_A)).toBe(Prisma.DbNull);
  });

  /**
   * „Nichts eingerichtet" is **not** „kaputt". This `null` is what keeps a fresh
   * installation usable: its mail stays `queued` with the same reason.
   */
  it('reads an empty system column as „not configured" rather than as a fault', () => {
    const { secrets } = harness();
    expect(secrets.openSystemBlock(null)).toBeNull();
  });

  /**
   * A mixed document is refused, not partially used — a foreign transport with
   * one's own sender address is the SPF/DKIM forgery of the requirement, and
   * half of it is a state the application cannot produce.
   */
  it('refuses a mixed block written in by hand', () => {
    const { secrets } = harness();
    expect(() =>
      secrets.openTenantBlock({ from: 'vorstand@example.org' }, TENANT_A),
    ).toThrow(MAIL_CONFIG_UNPARSABLE_REASON);
  });

  /**
   * The inheritance document from before ADR-0023 is no longer a valid one: it
   * is refused instead of being read as „kein Mailserver". Two meanings for one
   * state would be exactly the duplication that the clean cut avoids.
   */
  it('refuses the old inheritance document instead of reading it as „kein Mailserver"', () => {
    const { secrets } = harness();
    expect(() =>
      secrets.openTenantBlock({ source: 'system' }, TENANT_A),
    ).toThrow(MAIL_CONFIG_UNPARSABLE_REASON);
  });

  /** A relay without a login stays possible — the `.env` always allowed one. */
  it('carries a block without authentication through, in both directions', () => {
    const { secrets } = harness();
    const anonymous: SmtpBlock = { ...block('unused'), auth: null };

    const stored = secrets.sealSystemBlock(anonymous);
    expect(secrets.openSystemBlock(stored)).toStrictEqual(anonymous);
  });

  /**
   * The two refusals say what to do and name nothing. They end up in
   * `mail_log.last_error`, which an editor reads — and an error message is the
   * single most likely thing in an application to be pasted into a chat.
   */
  it('never repeats a value it choked on', () => {
    const { secrets } = harness();
    const password = mintPassword();
    let message = '';
    try {
      secrets.openTenantBlock(block(password), TENANT_A);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(MAIL_PASSWORD_UNREADABLE_REASON);
    expect(message).not.toContain(password);
    expect(message).not.toContain(TENANT_A);
  });
});

/**
 * **A review finding, closed as a type** (ADR-0013's sealing seam).
 *
 * A read-modify-write caller — somebody correcting a port without retyping
 * credentials — used to have a spelling that compiles and is wrong: hand the
 * document back to `seal…` and the password is sealed a second time. The value
 * in the column is then unopenable, and nothing says so until the next mail
 * fails to go out.
 *
 * ⚠️ **The refusal itself is a compile error and therefore invisible here** —
 * Vitest runs through SWC, which strips types without checking them. What this
 * suite can prove is the other half: that the shape which *is* allowed does the
 * right thing, so „keep the stored password" is not merely spellable but
 * correct.
 */
describe('a kept password is written through, not sealed again', () => {
  it('keeps the ciphertext of the previous save and still opens it', () => {
    const { secrets } = harness();
    const password = mintPassword();

    const first = secrets.sealTenantBlock(written(password), TENANT_A);
    const stored = secrets.storedTenantBlock(first);
    if (stored?.auth == null) {
      throw new Error('the sealed block should read back as a block');
    }

    // The save that changes a port and sends no password.
    const second = secrets.sealTenantBlock(
      {
        host: 'mail.neu.invalid',
        port: 465,
        secure: true,
        from: 'post@example.invalid',
        auth: {
          user: stored.auth.user,
          password: { kind: 'stored', value: stored.auth.password },
        },
      },
      TENANT_A,
    );

    const opened = secrets.openTenantBlock(second, TENANT_A);
    expect(opened?.host).toBe('mail.neu.invalid');
    // The load-bearing assertion: still the original password, not a value
    // wrapped twice — which is what a second `seal` would have produced.
    expect(opened?.auth?.password).toBe(password);
  });

  it('answers „gesetzt" only for a password that opens in this organisation', () => {
    const { secrets } = harness();
    const stored = secrets.storedTenantBlock(
      secrets.sealTenantBlock(written(mintPassword()), TENANT_A),
    );
    if (stored?.auth == null) {
      throw new Error('the sealed block should read back as a block');
    }

    expect(secrets.isPasswordUsable(stored.auth.password, TENANT_A)).toBe(true);
    // The same bytes in another organisation's row are not that organisation's password —
    // „nicht gesetzt", fail closed and repairable.
    expect(secrets.isPasswordUsable(stored.auth.password, TENANT_B)).toBe(
      false,
    );
    // And something that is not a sealed value at all is no password either.
    expect(
      secrets.isPasswordUsable(
        'formsache1.nonsense' as SealedSmtpPassword,
        TENANT_A,
      ),
    ).toBe(false);
  });
});
