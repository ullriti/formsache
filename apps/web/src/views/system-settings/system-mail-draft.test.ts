import { describe, expect, it } from 'vitest';

import {
  systemMailDirty,
  systemMailDraftOf,
  systemMailWriteOf,
} from './system-mail-draft';

/**
 * The one rule of the mail settings wire that is not a schema: how the draft
 * tells „unverändert" from „geleert" for the password (the requirement's
 * second reproduction).
 */

const CONFIGURED = {
  smtp: {
    host: 'mail.example.org',
    port: 587,
    secure: false,
    authUser: 'versand@example.org',
    from: 'versand@example.org',
  },
  publicBaseUrl: 'https://formulare.example.org',
  replyTo: null,
  opsAlertEmail: null,
};

const UNCONFIGURED = {
  smtp: null,
  publicBaseUrl: null,
  replyTo: null,
  opsAlertEmail: null,
};

describe('systemMailDraftOf', () => {
  it('starts the password at "keep", never at the stored value', () => {
    const draft = systemMailDraftOf(CONFIGURED);

    expect(draft.password).toEqual({ kind: 'keep' });
    expect(draft.enabled).toBe(true);
    expect(draft.host).toBe('mail.example.org');
    expect(draft.authEnabled).toBe(true);
    expect(draft.user).toBe('versand@example.org');
  });

  it('reads "nicht eingerichtet" as the switch being off', () => {
    const draft = systemMailDraftOf(UNCONFIGURED);

    expect(draft.enabled).toBe(false);
    expect(draft.host).toBe('');
  });

  it('reads a relay without a login as authEnabled: false', () => {
    const draft = systemMailDraftOf({
      smtp: { ...CONFIGURED.smtp, authUser: null },
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
    });

    expect(draft.authEnabled).toBe(false);
  });
});

describe('systemMailWriteOf — omitting the password keeps it stored', () => {
  it('sends no password field when nothing was typed', () => {
    const draft = systemMailDraftOf(CONFIGURED);

    const write = systemMailWriteOf(draft, 1);

    expect(write.smtp?.auth).toEqual({ user: 'versand@example.org' });
    expect(write.smtp?.auth).not.toHaveProperty('password');
  });

  it('sends the typed password when it was replaced', () => {
    const draft = {
      ...systemMailDraftOf(CONFIGURED),
      password: { kind: 'set' as const, value: 'neues-passwort' },
    };

    const write = systemMailWriteOf(draft, 1);

    expect(write.smtp?.auth).toEqual({
      user: 'versand@example.org',
      password: 'neues-passwort',
    });
  });

  it('sends `smtp: null` when the switch is off', () => {
    const draft = systemMailDraftOf(UNCONFIGURED);

    expect(systemMailWriteOf(draft, 1).smtp).toBeNull();
  });

  it('sends `auth: null` for a relay without a login', () => {
    const draft = {
      ...systemMailDraftOf(CONFIGURED),
      authEnabled: false,
    };

    expect(systemMailWriteOf(draft, 1).smtp?.auth).toBeNull();
  });

  it('trims the base address and reads a blank one as null', () => {
    const draft = { ...systemMailDraftOf(UNCONFIGURED), publicBaseUrl: '  ' };

    expect(systemMailWriteOf(draft, 1).publicBaseUrl).toBeNull();
  });

  it('carries the lock through unchanged', () => {
    expect(systemMailWriteOf(systemMailDraftOf(UNCONFIGURED), 7).lock).toBe(7);
  });
});

describe('systemMailDirty', () => {
  it('is not dirty right after loading', () => {
    const draft = systemMailDraftOf(CONFIGURED);
    expect(systemMailDirty(CONFIGURED, draft)).toBe(false);
  });

  it('is dirty once the password is typed, with nothing else changed', () => {
    const draft = {
      ...systemMailDraftOf(CONFIGURED),
      password: { kind: 'set' as const, value: 'x' },
    };
    expect(systemMailDirty(CONFIGURED, draft)).toBe(true);
  });

  it('is dirty when the switch is turned off', () => {
    const draft = { ...systemMailDraftOf(CONFIGURED), enabled: false };
    expect(systemMailDirty(CONFIGURED, draft)).toBe(true);
  });

  /**
   * **The trap „inside the block instead of beside it", as a measurement** :
   * the reply address alone makes the draft dirty, and it does so even without
   * a configured mail server — were it to lie in the block, this state would
   * not exist.
   *
   * *Re-enactment, measured (2026-08-04):* take `replyTo` out of
   * `besideBlockChanged` in `systemMailDirty` — **exactly this** case goes red
   * (1 failed, 1100 passed).
   */
  it('is dirty when only the reply address changes, with no mail server at all', () => {
    const draft = {
      ...systemMailDraftOf(UNCONFIGURED),
      replyTo: 'a@b.example',
    };
    expect(systemMailDirty(UNCONFIGURED, draft)).toBe(true);
    // …and the write carries it out beside `smtp: null`.
    expect(systemMailWriteOf(draft, 3)).toEqual({
      smtp: null,
      publicBaseUrl: null,
      replyTo: 'a@b.example',
      opsAlertEmail: null,
      lock: 3,
    });
  });

  it('sends null for a cleared reply address, never the empty string', () => {
    const draft = { ...systemMailDraftOf(UNCONFIGURED), replyTo: '   ' };
    expect(systemMailWriteOf(draft, 1).replyTo).toBeNull();
  });

  it('is dirty when only the base address changes, smtp untouched', () => {
    const draft = {
      ...systemMailDraftOf(CONFIGURED),
      publicBaseUrl: 'https://andere-adresse.example.org',
    };
    expect(systemMailDirty(CONFIGURED, draft)).toBe(true);
  });
});
