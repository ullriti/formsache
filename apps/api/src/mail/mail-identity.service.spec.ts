import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { SmtpBlock } from '@formsache/shared';

import { SecretBoxService } from '../common/secret-box/secret-box.service';
import { tenantOidcContext } from '../common/secret-box/secret-context';
import type { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import { MailIdentityService } from './mail-identity.service';
import {
  MAIL_CONFIG_UNPARSABLE_REASON,
  MAIL_PASSWORD_UNREADABLE_REASON,
  MailSecretsService,
  type SealableSmtpBlock,
} from './mail-secrets.service';
import {
  MAIL_NOT_CONFIGURED_REASON,
  TENANT_MAIL_NOT_CONFIGURED_REASON,
} from './mail-transport';

/**
 * **The three arms of ADR-0013 no. 5, at the level where they are decided.**
 *
 * The whole point of this file is that it distinguishes three cases and not
 * two. „Nichts eingerichtet" and „kaputt" look alike from the outside — both
 * mean „diese Mail geht gerade nicht raus" — and folding them together is the
 * convenient move that costs the property which makes a freshly set-up
 * installation usable: a withheld row waits and is sent by a
 * mail server configured next week, a failed one never is.
 *
 * The end-to-end half — what the *queue* does with each arm — belongs to
 * the mail module itself, which owns the worker.
 */

const KEY = Buffer.alloc(32, 5);

const TENANT_A = '019ff600-0000-7000-8000-0000000000c1';
const TENANT_B = '019ff600-0000-7000-8000-0000000000c2';

function mintPassword(): string {
  return `pw-${Math.random().toString(36).slice(2)}`;
}

const systemBlock = (password: string): SmtpBlock => ({
  host: 'mail.installation.invalid',
  port: 587,
  secure: false,
  auth: { user: 'installation', password },
  from: 'post@installation.invalid',
});

const ownBlock = (password: string): SmtpBlock => ({
  host: 'mail.organisation.invalid',
  port: 465,
  secure: true,
  auth: { user: 'Organisation', password },
  from: 'post@organisation.invalid',
});

const written = (block: SmtpBlock, password: string): SealableSmtpBlock => ({
  host: block.host,
  port: block.port,
  secure: block.secure,
  from: block.from,
  auth: { user: 'Organisation', password: { kind: 'typed', value: password } },
});

interface Harness {
  readonly identities: MailIdentityService;
  readonly secrets: MailSecretsService;
}

/** A sealed installation block, as `system_setting.smtp` would hold it. */
function sealedSystem(block: SmtpBlock): Prisma.JsonValue {
  return new MailSecretsService(new SecretBoxService(KEY)).sealSystemBlock(
    block,
  ) as Prisma.JsonValue;
}

/**
 * The service with a stubbed system row.
 *
 * `SystemMailSettingsService` is asked exactly one question here
 * (`storedSmtp`), and it reaches the database to answer it. Standing in for it
 * keeps these cases free of a container — what a *real* row does is proven in
 * `test/mail/identity-fail-closed.spec.ts`, against a real column and a raw
 * write.
 */
function harness(storedSystem: Prisma.JsonValue | null): Harness {
  const box = new SecretBoxService(KEY);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const secrets = new MailSecretsService(box);
  const settings = {
    storedSmtp: () => Promise.resolve(storedSystem),
  } as unknown as SystemMailSettingsService;
  return { identities: new MailIdentityService(settings, secrets), secrets };
}

describe('eine Organisation ohne eigenen Mailserver (ADR-0023)', () => {
  /**
   * ⚠️ **The reproduction of the abolished inheritance, and it is the
   * most important line of this file.**
   *
   * The system block is stored here in **working order**. That is exactly the
   * set-up ADR-0013 no. 4 demands for a fail-closed proof: were it not
   * working, the claim „es wurde nicht auf das System
   * zurückgefallen" would stay green even if there were a fallback. Whoever
   * builds the inheritance back in makes this line red.
   */
  it('hält zurück, statt über den Mailserver der Instanz zu senden', async () => {
    const { identities } = harness(sealedSystem(systemBlock(mintPassword())));

    const resolved = await identities.resolve(
      { id: TENANT_A, smtp: null },
      'tenant',
    );

    expect(resolved).toStrictEqual({
      kind: 'withhold',
      reason: TENANT_MAIL_NOT_CONFIGURED_REASON,
    });
  });

  /**
   * **The row that must not become a `failed`.** Nothing was attempted and
   * nothing was refused; the answer is a reason, and the queue leaves the row
   * alone. This is the property that lets a freshly created organisation work
   * before anybody has sorted out a mail server.
   */
  it('withholds — it does not fail — when nothing is set up at all', async () => {
    const { identities } = harness(null);

    expect(
      (await identities.resolve({ id: TENANT_A, smtp: null }, 'tenant')).kind,
    ).toBe('withhold');
  });

  /**
   * A left-behind `{"source":"system"}` is since ADR-0023 **no**
   * valid document any more: there is no installation to migrate, and a
   * tolerated old document would be a second meaning of „no mail server".
   * It is refused (`fail`), not read as „inherits".
   */
  it('lehnt das alte Vererbungs-Dokument ab, statt es zu deuten', async () => {
    const { identities } = harness(sealedSystem(systemBlock(mintPassword())));

    expect(
      await identities.resolve(
        { id: TENANT_A, smtp: { source: 'system' } },
        'tenant',
      ),
    ).toStrictEqual({
      kind: 'fail',
      reason: MAIL_CONFIG_UNPARSABLE_REASON,
    });
  });
});

describe('der Mailserver der Instanz (ADR-0023) — der Betreiber und der eine Sonderfall', () => {
  /**
   * `'system'` serves the operational alarms (ADR-0016), the test mail of the
   * system administration and **the one named special case**: an account that
   * belongs to no organisation at all (typically a superadmin without a
   * membership) otherwise has no way to an account mail.
   */
  it('löst den Block der Installation auf, ohne je eine Organisationsspalte zu lesen', async () => {
    const password = mintPassword();
    const { identities, secrets } = harness(
      sealedSystem(systemBlock(password)),
    );
    // An organisation with a working block of **its own** next to it: without
    // it, „die Spalte wurde nicht angesehen" would be true even if the column
    // were looked at and were empty.
    const own = mintPassword();
    const stored = secrets.sealTenantBlock(
      written(ownBlock(own), own),
      TENANT_A,
    ) as Prisma.JsonValue;

    const resolved = await identities.resolve(
      { id: TENANT_A, smtp: stored },
      'system',
    );

    expect(resolved.kind).toBe('send');
    expect(resolved.kind === 'send' ? resolved.source : null).toBe('system');
    expect(resolved.kind === 'send' ? resolved.block.host : null).toBe(
      'mail.installation.invalid',
    );
    // Opened, not merely read: what comes out of here goes to a transport.
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(password);
  });

  /** The operator too gets no `failed` when nothing is set up. */
  it('hält zurück, wenn die Installation keinen Mailserver hat', async () => {
    const { identities } = harness(null);

    expect(
      await identities.resolve({ id: TENANT_A, smtp: null }, 'system'),
    ).toStrictEqual({
      kind: 'withhold',
      reason: MAIL_NOT_CONFIGURED_REASON,
    });
  });
});

describe('an organisation with its own block ', () => {
  it('sends over its own block and never reaches for the system one', async () => {
    const own = mintPassword();
    const secrets = new MailSecretsService(new SecretBoxService(KEY));
    // Cast for the same reason `sealedSystem` above does: `sealTenantBlock`
    // types its result for the *write* side (`InputJsonValue | DbNull`), and
    // this test stands it in for what a read of the column hands back
    // (`resolve`'s parameter is `Prisma.JsonValue | null` since an earlier
    // review). A non-null block never produces `DbNull`, so the
    // narrowing is honest, not a workaround for the wrong type.
    const stored = secrets.sealTenantBlock(
      written(ownBlock(own), own),
      TENANT_A,
    ) as Prisma.JsonValue;
    // A **working** installation block next to it: without one, „es wurde
    // nicht auf das System zurückgefallen" would be true for the wrong reason.
    const { identities } = harness(sealedSystem(systemBlock(mintPassword())));

    const resolved = await identities.resolve(
      { id: TENANT_A, smtp: stored },
      'tenant',
    );

    expect(resolved.kind).toBe('send');
    expect(resolved.kind === 'send' ? resolved.source : null).toBe('own');
    expect(resolved.kind === 'send' ? resolved.block.host : null).toBe(
      'mail.organisation.invalid',
    );
    expect(resolved.kind === 'send' ? resolved.block.from : null).toBe(
      'post@organisation.invalid',
    );
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(own);
  });

  /**
   * **The mixed block of the requirement** — somebody else's transport with
   * one's own sender address, the SPF/DKIM forgery ADR-0013 no. 2 describes,
   * written in as half a document.
   *
   * It is refused, not completed from the system block: the answer is `fail`
   * with a readable reason, and it carries **no block at all**, so there is
   * nothing for a caller to send with.
   */
  it('fails on a mixed document instead of filling the gaps from the system', async () => {
    const { identities } = harness(sealedSystem(systemBlock(mintPassword())));

    const resolved = await identities.resolve(
      { id: TENANT_A, smtp: { from: 'vorstand@example.org' } },
      'tenant',
    );

    expect(resolved).toStrictEqual({
      kind: 'fail',
      reason: MAIL_CONFIG_UNPARSABLE_REASON,
    });
    expect(JSON.stringify(resolved)).not.toContain('installation.invalid');
  });

  /**
   * A password that does not open **here** — the shape a raw write across the
   * Organisation boundary produces.
   */
  it('fails on a password sealed for another organisation', async () => {
    const secrets = new MailSecretsService(new SecretBoxService(KEY));
    const password = mintPassword();
    // See the comment above on `stored`: same cast, same reason.
    const foreign = secrets.sealTenantBlock(
      written(ownBlock(password), password),
      TENANT_B,
    ) as Prisma.JsonValue;
    const { identities } = harness(null);

    const resolved = await identities.resolve(
      { id: TENANT_A, smtp: foreign },
      'tenant',
    );

    expect(resolved).toStrictEqual({
      kind: 'fail',
      reason: MAIL_PASSWORD_UNREADABLE_REASON,
    });
    // The reason is read by an editor in the mail log: no value, no id.
    expect(resolved.kind === 'fail' ? resolved.reason : '').not.toContain(
      TENANT_A,
    );
  });
});

describe('an unreadable installation block (a review finding)', () => {
  /**
   * Before this class the exception left the worker: it was raised **before any
   * row was claimed**, so no row got a `last_error`, the mail log showed
   * nothing, and the only trace was one line in a log. Fail *silent* — the worst
   * of the three possible failures.
   */
  it('answers `fail` instead of throwing, so every row can say why', async () => {
    const { identities } = harness({ host: 'mail.installation.invalid' });

    // Asked over the system lane, because since ADR-0023 that is the only way
    // on which the installation's block is read at all any more.
    const resolved = await identities.resolve(
      { id: TENANT_A, smtp: null },
      'system',
    );

    expect(resolved).toStrictEqual({
      kind: 'fail',
      reason: MAIL_CONFIG_UNPARSABLE_REASON,
    });
  });

  it('fails when the installation’s password does not open', async () => {
    const box = new SecretBoxService(KEY);
    const smuggled = {
      ...systemBlock('unused'),
      auth: {
        user: 'installation',
        password: box.seal(
          mintPassword(),
          tenantOidcContext(TENANT_A, 'oidc.client_secret'),
        ),
      },
    };
    const { identities } = harness(smuggled);

    expect(
      await identities.resolve({ id: TENANT_A, smtp: null }, 'system'),
    ).toStrictEqual({ kind: 'fail', reason: MAIL_PASSWORD_UNREADABLE_REASON });
  });

  /** A defect stays a defect — it must not be recorded as a mail problem. */
  it('re-throws anything that is not a refusal of the stored configuration', async () => {
    const box = new SecretBoxService(KEY);
    const secrets = new MailSecretsService(box);
    vi.spyOn(secrets, 'openTenantBlock').mockImplementation(() => {
      throw new TypeError('defect');
    });
    const settings = {
      storedSmtp: () => Promise.resolve(null),
    } as unknown as SystemMailSettingsService;

    await expect(
      new MailIdentityService(settings, secrets).resolve(
        {
          id: TENANT_A,
          smtp: null,
        },
        'tenant',
      ),
    ).rejects.toThrow(TypeError);
  });
});
