import { describe, expect, it } from 'vitest';

import {
  systemMailSettingsSchema,
  updateSystemMailSettingsRequestSchema,
} from './system-settings.ts';

/**
 * What the **installation** decides: its mail server and its own address.
 *
 * The settings layer that used to live in this row is gone (ADR-0011,
 * continuation 2026-08-14; review finding 9), and its tests with it — what a
 * form inherits is decided by its organisation and by the shipped constant, and
 * that is `form-settings.test.ts`'s subject. Nothing installation-wide can move
 * a form's settings any more, which is the property that block asserted.
 */

/**
 * The wire of the installation's mail server
 * and its base address.
 */
describe('systemMailSettingsSchema ', () => {
  const SMTP = {
    host: 'mail.example.org',
    port: 587,
    secure: false,
    authUser: 'versand@example.org',
    from: 'versand@example.org',
  };

  it('reads a configured block and an unconfigured one', () => {
    expect(
      systemMailSettingsSchema.parse({
        smtp: SMTP,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
      }),
    ).toEqual({
      smtp: SMTP,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
    });
    expect(
      systemMailSettingsSchema.parse({
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
      }),
    ).toEqual({
      smtp: null,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
    });
  });

  it('reads a relay without a login', () => {
    const parsed = systemMailSettingsSchema.parse({
      smtp: { ...SMTP, authUser: null },
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
    });
    expect(parsed.smtp?.authUser).toBeNull();
  });

  /**
   * The positive-list promise: a payload naming `password` anywhere in the
   * block is refused, not silently dropped — the structural half of the
   * guarantee: „das Passwort in die Leseantwort aufgenommen → der
   * Positivlisten-Test rot".
   */
  it('refuses a payload that carries a password', () => {
    const result = systemMailSettingsSchema.safeParse({
      smtp: { ...SMTP, password: 'geheim' },
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['password'],
    });
  });

  it('refuses an unknown top-level key', () => {
    expect(
      systemMailSettingsSchema.safeParse({
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        host: 'sneaked-in.example.org',
      }).success,
    ).toBe(false);
  });
});

describe('updateSystemMailSettingsRequestSchema ', () => {
  const FULL_SMTP = {
    host: 'mail.example.org',
    port: 587,
    secure: false,
    auth: { user: 'versand@example.org', password: 'Jahrestagung2026!' },
    from: 'versand@example.org',
  };

  it('accepts a complete block and the initial lock of a fresh installation', () => {
    const parsed = updateSystemMailSettingsRequestSchema.parse({
      smtp: FULL_SMTP,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    expect(parsed.smtp).toEqual(FULL_SMTP);
    expect(parsed.lock).toBe(1);
  });

  it('accepts a relay without a login', () => {
    expect(
      updateSystemMailSettingsRequestSchema.safeParse({
        smtp: { ...FULL_SMTP, auth: null },
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      }).success,
    ).toBe(true);
  });

  it('accepts removing the block entirely', () => {
    expect(
      updateSystemMailSettingsRequestSchema.safeParse({
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 3,
      }).success,
    ).toBe(true);
  });

  it('refuses a missing or non-positive lock instead of defaulting it', () => {
    // An optional or nullable lock is one the next client forgets to send —
    // exactly the trap `revision` one layer up avoids the same way.
    expect(
      updateSystemMailSettingsRequestSchema.safeParse({
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
      }).success,
    ).toBe(false);
    expect(
      updateSystemMailSettingsRequestSchema.safeParse({
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: null,
      }).success,
    ).toBe(false);
    expect(
      updateSystemMailSettingsRequestSchema.safeParse({
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 0,
      }).success,
    ).toBe(false);
  });

  /**
   * „Ein halb gefüllter eigener Block parst nicht,
   * und die Meldung nennt das fehlende Feld." The missing field this schema
   * alone can catch is anything but the password (see the next test for that
   * half, which is server state and cannot be a schema rule).
   */
  it.each(['host', 'port', 'secure', 'from'])(
    'refuses a block missing %s, and names the field',
    (missing) => {
      const half = Object.fromEntries(
        Object.entries(FULL_SMTP).filter(([key]) => key !== missing),
      );

      const result = updateSystemMailSettingsRequestSchema.safeParse({
        smtp: half,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

      expect(result.success).toBe(false);
      expect(
        result.error?.issues.some(
          (issue) => issue.path.join('.') === `smtp.${missing}`,
        ),
      ).toBe(true);
    },
  );

  /**
   * The other half of the same requirement — `auth: { user }` without a
   * password — parses **at this schema**, on purpose: absent means „keep the
   * stored password", and whether one is stored is server state this schema
   * cannot see. `SystemMailAdminService` refuses it when there is nothing to
   * keep, and that refusal is what the API integration suite pins down.
   */
  it('accepts an auth pair with the password omitted', () => {
    expect(
      updateSystemMailSettingsRequestSchema.safeParse({
        smtp: { ...FULL_SMTP, auth: { user: FULL_SMTP.auth.user } },
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      }).success,
    ).toBe(true);
  });

  it('refuses an auth pair with no user at all', () => {
    const result = updateSystemMailSettingsRequestSchema.safeParse({
      smtp: { ...FULL_SMTP, auth: { password: 'x' } },
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    expect(result.success).toBe(false);
  });

  /**
   * The three ways „das Passwort weglassen" can be gotten wrong, none of
   * them exercised before: `undefined` (the previous test) is „behalten", but
   * an explicit `null` or an empty string are not the same absence and must
   * not parse as one — a client that sent either would otherwise silently
   * clear or keep a password nobody meant to touch.
   */
  it('refuses `password: null` — that is not the same absence as omitting it', () => {
    const result = updateSystemMailSettingsRequestSchema.safeParse({
      smtp: {
        ...FULL_SMTP,
        auth: { user: FULL_SMTP.auth.user, password: null },
      },
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    expect(result.success).toBe(false);
  });

  it('refuses `password: ""` rather than storing an empty secret', () => {
    const result = updateSystemMailSettingsRequestSchema.safeParse({
      smtp: { ...FULL_SMTP, auth: { user: FULL_SMTP.auth.user, password: '' } },
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    expect(result.success).toBe(false);
  });

  /**
   * `smtp` is a required key of a `strictObject`, not an optional one: a
   * request that leaves it out entirely must fail here, at the schema, rather
   * than falling through to a service that has to guess what „nothing sent"
   * was supposed to mean.
   */
  it('refuses a request with no `smtp` key at all', () => {
    const result = updateSystemMailSettingsRequestSchema.safeParse({
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    expect(result.success).toBe(false);
  });

  it('refuses an unknown key inside the block instead of ignoring it', () => {
    const result = updateSystemMailSettingsRequestSchema.safeParse({
      smtp: { ...FULL_SMTP, replyTo: 'buero@example.org' },
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['replyTo'],
    });
  });

  it('normalises the base address and accepts null', () => {
    const parsed = updateSystemMailSettingsRequestSchema.parse({
      smtp: null,
      publicBaseUrl: 'https://formulare.example.org/',
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    // `baseUrlSchema` strips the trailing slash — used, not restated here.
    expect(parsed.publicBaseUrl).toBe('https://formulare.example.org');

    expect(
      updateSystemMailSettingsRequestSchema.parse({
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      }).publicBaseUrl,
    ).toBeNull();
  });
});
